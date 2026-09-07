import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { ModeratorReportStore } from "../src/coordination/moderator-reports.ts";

const input = { symptom: "Hung", suspectedDefect: "Wake lost", uncertainty: "Unconfirmed", recoveryActions: "Resume", recoveryOutcome: "Recovered", evidence: ["entry:call"] };
const reporter = { agentId: "moderator", label: "Moderator" };
const source = { agentId: "moderator", entryId: "entry", toolCallId: "call", transcriptPath: "/tmp/moderator.jsonl" };
function store(manager: SessionManager) {
	return new ModeratorReportStore({ transcript: transcriptFromSessionManager(manager), appendCustomEntry: (type, data) => manager.appendCustomEntry(type, data) });
}
function fixture() {
	const manager = SessionManager.create(tmpdir(), mkdtempSync(join(tmpdir(), "moderator-reports-")));
	// SessionManager persists custom entries after the first assistant message.
	manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Ready" }], api: "openai-responses", provider: "openai", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
	manager.appendCustomEntry("agent-coordination.identity", { agentId: manager.getSessionId() });
	return manager;
}

test("reports and explicit read acknowledgments survive cold reopen without deletion", () => {
	const manager = fixture();
	const reports = store(manager);
	const report = reports.publish(input, reporter, source);
	assert.deepEqual(reports.history(), [{ report }]);
	const reopened = store(SessionManager.open(manager.getSessionFile()!));
	assert.deepEqual(reopened.get(report.reportId), report);
	reopened.markRead(report.reportId);
	const afterRead = store(SessionManager.open(manager.getSessionFile()!));
	assert.deepEqual(afterRead.get(report.reportId), report);
	assert.ok(afterRead.history()[0]?.readAt);
	const firstRead = afterRead.history()[0]?.readAt;
	afterRead.markRead(report.reportId);
	assert.equal(afterRead.history()[0]?.readAt, firstRead);
	assert.throws(() => afterRead.markRead("missing"));
	assert.throws(() => afterRead.get("missing"));
});

test("publication is source-idempotent and reports cannot be mutated", () => {
	const manager = fixture();
	const reports = store(manager);
	const mutable = structuredClone(input);
	const report = reports.publish(mutable, reporter, source);
	mutable.evidence.push("later");
	assert.throws(() => (report.evidence as string[]).push("mutation"));
	assert.ok(Object.isFrozen(report) && Object.isFrozen(report.source) && Object.isFrozen(report.reporter));
	assert.deepEqual(store(manager).publish({ ...input, symptom: "changed" }, reporter, source), report);
	assert.equal(reports.history().length, 1);
	assert.deepEqual(report.evidence, input.evidence);
	assert.throws(() => reports.publish({ ...input, symptom: " " }, reporter, { ...source, toolCallId: "invalid" }));
	assert.equal(reports.history().length, 1);
});

test("a new Owner identity cutoff excludes copied reports", () => {
	const manager = fixture();
	const reports = store(manager);
	reports.publish(input, reporter, source);
	manager.appendCustomEntry("agent-coordination.identity", { agentId: manager.getSessionId() });
	assert.deepEqual(reports.history(), []);
});
