import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import xterm from "@xterm/headless";
import type { ExtensionUIContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Editor, TuiAltScreen, TuiMainScreen, getKeybindings, visibleWidth, type Component, type OverlayHandle, type OverlayOptions, type Terminal, type TuiMouseEvent, type TUI } from "@earendil-works/pi-tui";
import type { AgentRosterStatus } from "../src/coordination/workflow-coordinator.ts";
import { openAgentSelectorSurface, type AgentSelectorAction, type AgentSelectorOptions } from "../src/presentation/agent-selector-surface.ts";

const identity = (text: string) => text;
const theme = {
	fg: (color: string, text: string) => `\x1b[${color === "text" ? 37 : color === "accent" ? 36 : 90}m${text}\x1b[39m`,
	bg: (color: string, text: string) => `\x1b[${color === "selectedBg" ? 44 : 100}m${text}\x1b[49m`,
	getBgAnsi: (color: string) => `\x1b[${color === "selectedBg" ? 44 : 100}m`,
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

async function harness(t: TestContext, options: Partial<AgentSelectorOptions> = {}, mode: "fullscreen" | "regular" = "fullscreen") {
	const terminal = new ScreenTerminal();
	const tui = mode === "fullscreen" ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
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
		custom<T>(factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (value: T) => void) => Component,
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
		return { x: visibleWidth(lines[y]!.slice(0, lines[y]!.indexOf(text))) + offset, y };
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

test("async preparation retains keyboard focus and blocks pointer actions inside the panel", { timeout: 5_000 }, async (t) => {
	let release!: () => void;
	const pending = new Promise<void>((resolve) => { release = resolve; });
	const actions: AgentSelectorAction[] = [];
	const h = await harness(t, { prepareSelection(action) { actions.push(action); return pending; } });
	try {
		await h.click("Branch");
		assert.equal(actions.length, 1);
		assert.equal(h.resolved, false);
		const bounds = h.overlay!.getBounds()!;
		assert.equal(bounds.width, 80);
		assert.ok(bounds.row > 0 && bounds.height < h.terminal.rows);
		assert.match((await h.frame()).join("\n"), /ROOT EDITOR/);
		for (const [x, y] of [[bounds.col, bounds.row], [bounds.col + bounds.width - 1, bounds.row + bounds.height - 1]]) {
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

test("preparation feedback survives resizing the roster viewport", { timeout: 5_000 }, async (t) => {
	let release!: () => void;
	const pending = new Promise<void>((resolve) => { release = resolve; });
	const live = [status("owner", "Owner", null), ...Array.from({ length: 20 }, (_, i) => status("agent-" + i, "Agent " + i))];
	const h = await harness(t, { live, selectedAgentId: "agent-0", prepareSelection: () => pending });
	try {
		await h.click("Agent 1");
		h.terminal.resize(80, 15);
		assert.match((await h.frame()).join("\n"), /→ Agent 1\s+⠋ loading/);
		assert.equal(h.overlay?.getBounds()?.width, 80);
		assert.ok(h.overlay!.getBounds()!.height < 15);
	} finally { release(); }
	await h.result;
});

test("visible breadcrumb cells navigate; omitted/current segments and clipped controls are informational", { timeout: 5_000 }, async (t) => {
	const live = [
		status("owner", "Owner", null), status("alpha", "Alpha"),
		status("beta", "研究", "alpha"), status("gamma", "Gamma", "beta"),
		status("delta", "Delta", "gamma"), status("leaf", "Leaf", "delta"),
	];
	const h = await harness(t, { live, selectedAgentId: "leaf" });
	await h.click("…");
	await h.click("Delta");
	assert.match((await h.frame()).join("\n"), /→ Leaf/);
	await h.click("研究", 2);
	assert.match((await h.frame()).join("\n"), /→ Gamma/);
	assert.equal(h.resolved, false);
	// At this width only the current scope fits; the discarded ancestor cannot
	// leave a hit target behind after the resize.
	h.terminal.resize(19, 15);
	await h.frame();
	await h.click("研究");
	assert.match((await h.frame()).join("\n"), /→ /);
	assert.equal(h.resolved, false);
	await h.input("\x1b");

	const clipped = await harness(t);
	clipped.terminal.resize(14, 15);
	await clipped.frame();
	await clipped.click("[1 child");
	assert.equal(clipped.resolved, false);
	clipped.terminal.resize(80, 30);
	assert.match((await clipped.frame()).join("\n"), /→ Branch/);
	// Even the blank cell immediately before the complete child control belongs
	// to the participant body; the closing bracket belongs to browsing.
	const child = await clipped.point("[1 child ›]");
	clipped.terminal.mouse(0, child.x - 1, child.y);
	clipped.terminal.mouse(0, child.x - 1, child.y, true);
	await clipped.frame();
	assert.deepEqual(await clipped.result, { kind: "select_agent", agentId: "branch" });
});

test("pointer opening is independent of confirmation bindings while keyboard uses them", { timeout: 5_000 }, async (t) => {
	const keybindings = getKeybindings();
	const previousBindings = keybindings.getUserBindings();
	t.after(() => keybindings.setUserBindings(previousBindings));
	keybindings.setUserBindings({
		...previousBindings,
		"tui.select.confirm": "space",
		"tui.select.down": "enter",
	});

	const agent = await harness(t);
	await agent.click("Other");
	assert.equal(agent.resolved, true, "Agent click must not dispatch a confirmation key");
	assert.deepEqual(await agent.result, { kind: "select_agent", agentId: "other" });

	const owner = await harness(t);
	await owner.click("[Owner]");
	assert.equal(owner.resolved, true);
	assert.deepEqual(await owner.result, { kind: "select_agent", agentId: "owner" });

	const attention = await harness(t, {
		humanAttention: [{ requestId: "decision", agentId: "branch", agentLabel: "Branch", question: "Proceed?" }],
	});
	await attention.click("DECIDE");
	assert.equal(attention.resolved, true);
	assert.deepEqual(await attention.result, { kind: "decide", requestId: "decision", agentId: "branch" });

	const keyboard = await harness(t);
	await keyboard.input("\r");
	assert.equal(keyboard.resolved, false, "rebound Enter moves selection rather than confirming");
	assert.match((await keyboard.frame()).join("\n"), /→ Other/);
	await keyboard.input(" ");
	assert.deepEqual(await keyboard.result, { kind: "select_agent", agentId: "other" });
});

for (const mode of ["fullscreen", "regular"] as const) {
	test(mode + " selector preserves the mounted chat outside its frame", { timeout: 5_000 }, async (t) => {
		const h = await harness(t, {}, mode);
		assert.match((await h.frame()).join("\n"), /ROOT EDITOR/);
		h.editor.setText("CHAT UPDATED UNDER SELECTOR");
		assert.match((await h.frame()).join("\n"), /CHAT UPDATED UNDER SELECTOR/);
	});
}

test("hover adds a faint background without changing foregrounds or selected backgrounds", { timeout: 5_000 }, async (t) => {
	const h = await harness(t);
	for (const target of ["[Owner]", "Other", "Branch", "[1 child ›]", "Dormant"]) {
		const p = await h.point(target);
		const before = Array.from({ length: h.terminal.columns }, (_, x) => h.terminal.screen.buffer.active.getLine(p.y)!.getCell(x)!.getFgColor());
		h.terminal.mouse(35, p.x, p.y);
		await h.frame();
		const row = h.terminal.screen.buffer.active.getLine(p.y)!;
		const hovered = row.getCell(p.x)!;
		const background = target === "Branch" ? 4 : 8;
		assert.equal(hovered.getBgColor(), background, target + " uses the appropriate background");
		const right = row.translateToString(true).lastIndexOf("│");
		for (let x = right - 1; x < h.terminal.columns; x++) {
			assert.equal(row.getCell(x)!.isBgDefault(), true, target + " background ends before frame padding at " + x);
		}
		const end = target === "Other" ? right - 1
			: target === "Branch" ? row.translateToString(true).indexOf("[1 child")
			: p.x + visibleWidth(target);
		for (let x = p.x; x < end; x++) {
			assert.equal(row.getCell(x)!.getFgColor(), before[x], target + " retains its foreground at " + x);
			assert.equal(row.getCell(x)!.getBgColor(), background, target + " fills the pointed control at " + x);
		}
		if (target === "[Owner]") {
			assert.equal(row.getCell(p.x + target.length)!.isBgDefault(), true, "Owner hover must not bleed onto chevron");
		}
	}
});

test("hovering a keyboard-focused Owner does not paint the rest of its row", { timeout: 5_000 }, async (t) => {
	const h = await harness(t);
	await h.input("\x1b[A");
	const p = await h.point("[Owner]");
	h.terminal.mouse(35, p.x, p.y);
	await h.frame();
	const row = h.terminal.screen.buffer.active.getLine(p.y)!;
	for (let x = p.x + "[Owner]".length; x < h.terminal.columns; x++) {
		assert.equal(row.getCell(x)!.isBgDefault(), true, "Owner background leaked to column " + x);
	}
});

test("row and child button expose separate bounded hover actions", { timeout: 5_000 }, async (t) => {
	const h = await harness(t, { selectedAgentId: "other" });
	const body = await h.point("Branch");
	const child = await h.point("[1 child ›]");
	const selected = await h.point("Other");
	const bg = (x: number, y: number) => h.terminal.screen.buffer.active.getLine(y)!.getCell(x)!.getBgColor();
	assert.equal(bg(selected.x, selected.y), 4, "keyboard-selected row has the stronger background");
	h.terminal.mouse(35, body.x, body.y);
	await h.frame();
	assert.equal(bg(body.x, body.y), 8);
	assert.equal(bg(child.x - 1, child.y), 8, "open action extends to the button boundary");
	assert.equal(h.terminal.screen.buffer.active.getLine(child.y)!.getCell(child.x)!.isBgDefault(), true);
	h.terminal.mouse(35, child.x, child.y);
	await h.frame();
	assert.equal(h.terminal.screen.buffer.active.getLine(body.y)!.getCell(body.x)!.isBgDefault(), true);
	for (let x = child.x; x < child.x + "[1 child ›]".length; x++) assert.equal(bg(x, child.y), 8);
	assert.equal(bg(selected.x, selected.y), 4, "child hover does not replace selection");
	await h.click("[1 child ›]", 10);
	assert.equal(h.resolved, false);
	assert.match((await h.frame()).join("\n"), /→ Nested/);
});

test("selected tabs and Owner retain selection color when hovered", { timeout: 5_000 }, async (t) => {
	const h = await harness(t);
	await h.input("\x1b[A");
	for (const target of ["Live", "[Owner]"]) {
		const p = await h.point(target);
		const before = h.terminal.screen.buffer.active.getLine(p.y)!.getCell(p.x)!;
		const foreground = before.getFgColor();
		assert.equal(before.getBgColor(), 4);
		h.terminal.mouse(35, p.x, p.y);
		await h.frame();
		const after = h.terminal.screen.buffer.active.getLine(p.y)!.getCell(p.x)!;
		assert.equal(after.getBgColor(), 4);
		assert.equal(after.getFgColor(), foreground);
	}
	await h.click("Dormant");
	const p = await h.point("Dormant");
	assert.equal(h.terminal.screen.buffer.active.getLine(p.y)!.getCell(p.x)!.getBgColor(), 4);
});

test("truncated Agent summaries keep tint through their padding without swallowing the child button", { timeout: 5_000 }, async (t) => {
	const h = await harness(t, {
		live: [status("owner", "Owner", null), status("branch", "Long ".repeat(30)), status("other", "Other"), status("child", "Child", "branch")],
		selectedAgentId: "other",
	});
	h.terminal.resize(46, 30);
	const p = await h.point("Long ");
	const child = await h.point("[1 child ›]");
	h.terminal.mouse(35, p.x, p.y);
	await h.frame();
	const row = h.terminal.screen.buffer.active.getLine(p.y)!;
	for (let x = p.x; x < child.x; x++) assert.equal(row.getCell(x)!.getBgColor(), 8);
	assert.equal(row.getCell(child.x)!.isBgDefault(), true);
});
