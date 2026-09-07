import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionUIContext, Theme, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { openModeratorReportSurface } from "../src/presentation/moderator-report-surface.ts";
import { formatModeratorReport, type ReportHistoryItem } from "../src/protocol/moderator-report.ts";

const item: ReportHistoryItem = { report: {
	reportId: "report-1", createdAt: "2026-01-01T00:00:00Z",
	reporter: { agentId: "moderator", label: "Moderator" },
	source: { agentId: "moderator", entryId: "entry", toolCallId: "call", transcriptPath: "/tmp/source.jsonl" },
	symptom: "Delivery stalled", suspectedDefect: "Dispatch race", uncertainty: "Not reproduced",
	recoveryActions: "Retried", recoveryOutcome: "Recovered", evidence: ["receipt-1"],
} };

function harness(rows = 15) {
	let component!: Component;
	const ui = { custom<T>(factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (result: T) => void) => Component) {
		return new Promise<T>((resolve) => {
			component = factory({ terminal: { rows }, requestRender() {} } as unknown as TUI,
				{ fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme,
				{} as KeybindingsManager, resolve);
		});
	} } as unknown as ExtensionUIContext;
	return { ui, get component() { return component; } };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("opening, copying, and closing a report do not mark it read", async () => {
	const h = harness();
	let reads = 0;
	let copied = "";
	const result = openModeratorReportSurface(h.ui, item, {
		markRead() { reads++; }, copyReport(text) { copied = text; },
	});
	assert.match(h.component.render(80).join("\n"), /Unread/);
	h.component.handleInput?.("c");
	await flush();
	assert.equal(copied, formatModeratorReport(item.report));
	assert.equal(reads, 0);
	h.component.handleInput?.("\x1b");
	assert.equal(await result, "back");
	assert.equal(reads, 0);
});

test("Mark read waits for persistence, is idempotent, and View reporter is separate", async () => {
	const h = harness();
	let reads = 0;
	let persist!: () => void;
	const result = openModeratorReportSurface(h.ui, item, {
		markRead() { reads++; return new Promise<void>((resolve) => { persist = resolve; }); },
		copyReport() {},
	});
	h.component.handleInput?.("m");
	h.component.handleInput?.("m");
	assert.match(h.component.render(80).join("\n"), /Unread/);
	persist();
	await flush();
	assert.match(h.component.render(80).join("\n"), /Read/);
	assert.doesNotMatch(h.component.render(80).join("\n"), /Unread/);
	h.component.handleInput?.("m");
	assert.equal(reads, 1);
	h.component.handleInput?.("v");
	assert.equal(await result, "view_reporter");
});

test("failed Mark read remains unread and can retry", async () => {
	const h = harness();
	let reads = 0;
	const result = openModeratorReportSurface(h.ui, item, {
		markRead() { if (++reads === 1) throw new Error("Disk full"); }, copyReport() {},
	});
	h.component.handleInput?.("m");
	await flush();
	assert.match(h.component.render(80).join("\n"), /Unread/);
	assert.match(h.component.render(80).join("\n"), /Disk full/);
	h.component.handleInput?.("m");
	await flush();
	assert.doesNotMatch(h.component.render(80).join("\n"), /Unread/);
	h.component.handleInput?.("q");
	await result;
});

test("the complete report scrolls safely within terminal bounds", async () => {
	const h = harness(12);
	const unsafeItem = { report: { ...item.report,
		symptom: "Safe\x1b]52;c;attack\x07\x1b[2J\rtext\x85",
		evidence: Array.from({ length: 30 }, (_, i) => `Evidence ${i} 界`),
	} };
	const result = openModeratorReportSurface(h.ui, unsafeItem, { markRead() {}, copyReport() {} });
	const seen: string[] = [];
	for (let i = 0; i < 100; i++) {
		const lines = h.component.render(40);
		assert.ok(lines.length <= 12);
		assert.ok(lines.every((line) => visibleWidth(line) <= 40));
		seen.push(...lines);
		h.component.handleInput?.("j");
	}
	const rendered = seen.join("\n");
	assert.match(rendered, /source.jsonl/);
	assert.match(rendered, /Evidence 29/);
	assert.doesNotMatch(rendered, /\x1b\]|\x1b\[2J|\r|\x85|attack/);
	h.component.handleInput?.("\x1b[H");
	assert.match(h.component.render(40).join("\n"), /Moderator report report-1/);
	h.component.handleInput?.("q");
	await result;
});

test("View reporter leaves an unread report unread, and prior read state survives reopening", async () => {
	for (const historyItem of [item, { ...item, readAt: "2026-01-02T00:00:00Z" }]) {
		const h = harness();
		let reads = 0;
		const result = openModeratorReportSurface(h.ui, historyItem, {
			markRead() { reads++; }, copyReport() {},
		});
		assert.match(h.component.render(80).join("\n"), historyItem.readAt ? / · Read/ : / · Unread/);
		h.component.handleInput?.("v");
		assert.equal(await result, "view_reporter");
		assert.equal(reads, 0);
	}
});
