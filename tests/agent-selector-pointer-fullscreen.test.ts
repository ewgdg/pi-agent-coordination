import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import xterm from "@xterm/headless";
import type { ExtensionUIContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Editor, TuiAltScreen, type Component, type OverlayHandle, type OverlayOptions, type Terminal, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { AgentRosterStatus } from "../src/coordination/workflow-coordinator.ts";
import { openAgentSelectorSurface, type AgentSelectorAction, type AgentSelectorOptions } from "../src/presentation/agent-selector-surface.ts";

const identity = (text: string) => text;
const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => "\x1b[44m" + text + "\x1b[49m",
	bold: identity,
} as Theme;

// Only this terminal boundary encodes mouse reports: the selector receives the
// renderer's normalized events, never manually constructed component events.
class ScreenTerminal implements Terminal {
	columns = 120;
	rows = 30;
	kittyProtocolActive = false;
	screen = new xterm.Terminal({ cols: this.columns, rows: this.rows, allowProposedApi: true });
	input: (data: string) => void = () => {};
	resizeHandler: () => void = () => {};
	start(input: (data: string) => void, resize: () => void) { this.input = input; this.resizeHandler = resize; }
	stop() {}
	async drainInput() {}
	write(data: string) { this.screen.write(data); }
	moveBy(lines: number) { this.write("\x1b[" + Math.abs(lines) + (lines < 0 ? "A" : "B")); }
	hideCursor() { this.write("\x1b[?25l"); }
	showCursor() { this.write("\x1b[?25h"); }
	clearLine() { this.write("\x1b[2K"); }
	clearFromCursor() { this.write("\x1b[J"); }
	clearScreen() { this.write("\x1b[2J"); }
	setTitle() {}
	setProgress() {}
	async flush() { await new Promise<void>((resolve) => this.screen.write("", resolve)); }
	resize(columns: number, rows: number) {
		this.columns = columns; this.rows = rows;
		this.screen.resize(columns, rows);
		this.resizeHandler();
	}
	lines() {
		return Array.from({ length: this.rows }, (_, row) =>
			this.screen.buffer.active.getLine(row)?.translateToString(true) ?? "");
	}
	mouse(code: number, x: number, y: number, release = false) {
		this.input("\x1b[<" + code + ";" + (x + 1) + ";" + (y + 1) + (release ? "m" : "M"));
	}
}

class EditorSpy extends Editor {
	keyInputs: string[] = [];
	mouseInputs: TuiMouseEvent[] = [];
	override handleInput(data: string) { this.keyInputs.push(data); super.handleInput(data); }
	override handleMouse(event: TuiMouseEvent) { this.mouseInputs.push(event); return super.handleMouse(event); }
}

function status(agentId: string, label: string, parent: string | null = "owner"): AgentRosterStatus {
	return {
		agentId, label, workflowId: "owner", directSpawnerAgentId: parent,
		description: label + " informational details",
		primaryEvidence: { transcriptPath: null, inspectedThrough: { agentId, entryId: "entry-" + agentId } },
		run: { phase: "live", work: "settled", attention: "none", retentionReasons: [] },
		model: { provider: "test", modelId: "model" }, thinking: "off", compacting: false, queuedInputCount: 0,
	};
}
const roster = [
	status("owner", "Owner", null), status("branch", "Branch"),
	status("other", "Other"), status("nested", "Nested", "branch"),
	status("leaf", "Leaf", "nested"),
];
const sleeping: AgentRosterStatus = { ...status("sleeping", "Sleeping"), run: { phase: "dormant" as const, retentionReasons: [] } };

async function harness(t: TestContext, options: Partial<AgentSelectorOptions> = {}) {
	const terminal = new ScreenTerminal();
	const tui = new TuiAltScreen(terminal);
	const editor = new EditorSpy(tui, {
		borderColor: identity,
		selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity },
	});
	editor.setText("ROOT EDITOR");
	tui.addChild(editor);
	tui.setFocus(editor);
	tui.start();
	let component: (Component & { dispose?(): void }) | undefined;
	let overlay: OverlayHandle | undefined;
	let resolved = false;
	const ui = {
		custom<T>(factory: (tui: TuiAltScreen, theme: Theme, keys: KeybindingsManager, done: (value: T) => void) => Component,
			config: { overlayOptions?: OverlayOptions }) {
			return new Promise<T>((resolve) => {
				component = factory(tui, theme, {} as KeybindingsManager, (value) => {
					resolved = true; overlay?.hide(); component?.dispose?.(); resolve(value);
				});
				overlay = tui.showOverlay(component, config.overlayOptions);
			});
		},
	} as unknown as ExtensionUIContext;
	const result = openAgentSelectorSurface(ui, { live: roster, dormant: [sleeping], selectedAgentId: "branch", ...options });
	async function frame() { tui.renderNow(); await terminal.flush(); return terminal.lines(); }
	async function input(data: string) { terminal.input(data); await frame(); }
	async function point(text: string, offset = 0) {
		const lines = await frame();
		const y = lines.findIndex((line) => line.includes(text));
		assert.ok(y >= 0, "Missing visible target " + text + "\n" + lines.join("\n"));
		return { x: lines[y]!.indexOf(text) + offset, y };
	}
	async function click(text: string, offset = 0, button = 0) {
		const { x, y } = await point(text, offset);
		terminal.mouse(button, x, y);
		terminal.mouse(button, x, y, true);
		await frame();
	}
	t.after(() => { component?.dispose?.(); overlay?.hide(); tui.stop(); terminal.screen.dispose(); });
	await frame();
	return { terminal, tui, editor, result, frame, input, point, click, get resolved() { return resolved; }, get overlay() { return overlay; } };
}

test("fullscreen pointer tabs, Owner and summary actions use terminal mouse dispatch", { timeout: 5_000 }, async (t) => {
	const h = await harness(t);
	await h.click("Dormant");
	assert.match((await h.frame()).join("\n"), /→ Sleeping/);
	await h.click("Live");
	assert.match((await h.frame()).join("\n"), /→ Branch/);
	await h.click("Other");
	assert.equal(h.resolved, true);
	assert.deepEqual(await h.result, { kind: "select_agent", agentId: "other" });

	const owner = await harness(t);
	await owner.click("[Owner]", 2);
	assert.equal(owner.resolved, true);
	assert.deepEqual(await owner.result, { kind: "select_agent", agentId: "owner" });
});

test("the entire child control browses, ancestors and Owner chevron return to their scopes", { timeout: 5_000 }, async (t) => {
	for (const offset of [0, 3, 9, 10]) {
		const h = await harness(t);
		await h.click("[1 child ›]", offset);
		assert.equal(h.resolved, false);
		assert.match((await h.frame()).join("\n"), /→ Nested/);
		await h.click("[1 child ›]", 3);
		assert.match((await h.frame()).join("\n"), /→ Leaf/);
		await h.click("Branch");
		assert.match((await h.frame()).join("\n"), /→ Nested/);
		await h.click("[›]", 1);
		assert.match((await h.frame()).join("\n"), /→ Branch/);
		await h.input("\x1b");
	}
});

test("hover highlights without moving keyboard selection; details and other buttons are inert", { timeout: 5_000 }, async (t) => {
	const h = await harness(t);
	const other = await h.point("Other");
	const before = h.terminal.screen.buffer.active.getLine(other.y)!.getCell(other.x)!.getBgColor();
	h.terminal.mouse(35, other.x, other.y);
	await h.frame();
	const after = h.terminal.screen.buffer.active.getLine(other.y)!.getCell(other.x)!.getBgColor();
	assert.notEqual(after, before, "hover should visibly highlight the target");
	assert.match((await h.frame()).join("\n"), /→ Branch/);
	for (const button of [1, 2]) {
		await h.click("Other", 1, button);
		await h.click("Dormant", 1, button);
		await h.click("[Owner]", 1, button);
		await h.click("[1 child ›]", 3, button);
	}
	await h.click("Branch informational details");
	assert.equal(h.resolved, false);
	await h.input("\r");
	assert.deepEqual(await h.result, { kind: "select_agent", agentId: "branch" });
});

test("wheel is roster-scoped and keeps scrolling hit targets correct after resizing", { timeout: 5_000 }, async (t) => {
	const live = [status("owner", "Owner", null), ...Array.from({ length: 25 }, (_, i) => status("agent-" + i, "Agent " + String(i).padStart(2, "0")))];
	const h = await harness(t, { live, selectedAgentId: "agent-0" });
	for (const target of ["Live", "[Owner]", "informational details", "o Owner"]) {
		const p = await h.point(target);
		h.terminal.mouse(65, p.x, p.y);
		await h.frame();
		assert.match((await h.frame()).join("\n"), /→ Agent 00/);
	}
	for (let step = 0; step < 12; step++) {
		const lines = await h.frame();
		const row = lines.find((line) => line.includes("→ Agent"))!;
		const p = await h.point(row.trim().replace(/^│\s*/, "").split("  ")[0]!);
		h.terminal.mouse(65, p.x, p.y);
		await h.frame();
	}
	assert.doesNotMatch((await h.frame()).join("\n"), /→ Agent 00/);
	for (const [columns, rows] of [[46, 15], [24, 10], [120, 30]]) {
		h.terminal.resize(columns!, rows!);
		const lines = await h.frame();
		const top = lines.findIndex((line) => line.includes("┌"));
		const bottom = lines.findIndex((line) => line.includes("└"));
		assert.ok(top >= 1 && bottom < rows! - 1, "panel retains terminal margins");
		assert.ok(bottom - top + 1 <= Math.floor(rows! * 0.9));
		const left = lines[top]!.indexOf("┌");
		const right = lines[top]!.indexOf("┐");
		assert.ok(right - left + 1 <= Math.min(80, columns!));
		assert.equal(left, Math.floor((columns! - (right - left + 1)) / 2));
	}
	const lines = await h.frame();
	const selected = lines.find((line) => line.includes("→ Agent"))!.match(/Agent (\d+)/)![1]!;
	await h.click("Agent " + selected);
	assert.equal(h.resolved, true);
	assert.deepEqual(await h.result, { kind: "select_agent", agentId: "agent-" + Number(selected) });
});

test("async preparation captures the whole screen, including editor outside the centered panel", { timeout: 5_000 }, async (t) => {
	let release!: () => void;
	const pending = new Promise<void>((resolve) => { release = resolve; });
	const actions: AgentSelectorAction[] = [];
	const h = await harness(t, { prepareSelection(action) { actions.push(action); return pending; } });
	try {
		await h.click("Branch");
		assert.equal(actions.length, 1);
		assert.equal(h.resolved, false);
		assert.deepEqual(h.overlay?.getBounds(), { row: 0, col: 0, width: 120, height: 30 });
		// The mounted Editor occupies the top rows, outside the panel, and would
		// receive this press and keyboard focus without the full-screen shield.
		for (const [x, y] of [[2, 1], [119, 29], [0, 0]]) {
			for (const button of [0, 1, 2]) {
				h.terminal.mouse(button, x!, y!);
				h.terminal.mouse(button, x!, y!, true);
			}
			h.terminal.mouse(65, x!, y!);
		}
		await h.input("z");
		await h.input("\r");
		await h.input("\x1b");
		await h.click("Other");
		await h.click("Dormant");
		assert.equal(actions.length, 1);
		assert.equal(h.resolved, false);
		assert.deepEqual(h.editor.mouseInputs, []);
		assert.deepEqual(h.editor.keyInputs, []);
		assert.equal(h.editor.getText(), "ROOT EDITOR");
	} finally { release(); }
	assert.deepEqual(await h.result, { kind: "select_agent", agentId: "branch" });
	await h.input("z");
	assert.deepEqual(h.editor.keyInputs, ["z"], "closing restores the mounted Editor focus");
});
