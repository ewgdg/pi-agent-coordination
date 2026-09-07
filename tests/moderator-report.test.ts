import assert from "node:assert/strict";
import test from "node:test";
import { formatModeratorReport, validateReportToUserInput } from "../src/protocol/moderator-report.ts";

const input = { symptom: "Hung tool", suspectedDefect: "Missing wake", uncertainty: "Not reproduced", recoveryActions: "Resumed agent", recoveryOutcome: "Completed", evidence: ["session:entry:call"] };

test("report input requires nonblank narrative fields and evidence", () => {
	assert.deepEqual(validateReportToUserInput(input), input);
	for (const field of ["symptom", "suspectedDefect", "uncertainty", "recoveryActions", "recoveryOutcome"]) {
		for (const value of ["", " \n", null, 4]) assert.throws(() => validateReportToUserInput({ ...input, [field]: value }));
	}
	for (const evidence of [[], [" "], [2], null, "entry"]) assert.throws(() => validateReportToUserInput({ ...input, evidence }));
	assert.throws(() => validateReportToUserInput(null));
});

test("ticket formatting retains findings and exact source", () => {
	const report = { ...input, reportId: "report-1", createdAt: "2026-01-01T00:00:00.000Z", reporter: { agentId: "moderator", label: "Moderator" }, source: { agentId: "moderator", entryId: "entry-1", toolCallId: "call-1", transcriptPath: "/tmp/moderator.jsonl" } };
	const formatted = formatModeratorReport(report);
	for (const value of [...Object.values(input).flat(), report.reportId, report.createdAt, ...Object.values(report.source), report.reporter.label]) assert.ok(formatted.includes(value));
});
