import assert from "node:assert/strict";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
	AgentTranscript,
	type TranscriptInspection,
	type TranscriptReader,
} from "../src/transcript/agent-transcript.ts";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";

test("AgentTranscript asks its reader for a fresh inspection every time", () => {
	const inspections: TranscriptInspection[] = [
		inspection("agent-1", "entry-1"),
		inspection("agent-1", "entry-2"),
	];
	let reads = 0;
	const reader: TranscriptReader = {
		read() {
			return inspections[reads++]!;
		},
	};
	const transcript = new AgentTranscript(reader);

	assert.equal(transcript.inspect(), inspections[0]);
	assert.equal(transcript.inspect(), inspections[1]);
	assert.equal(reads, 2);
});

test("local SessionManager transcript inspections are snapshots, not a shared cache", () => {
	const sessionManager = SessionManager.inMemory("/workflow", { id: "agent-1" });
	sessionManager.appendCustomEntry("agent-coordination.identity", { agentId: "agent-1" });
	const transcript = transcriptFromSessionManager(sessionManager);

	const before = transcript.inspect();
	sessionManager.appendCustomEntry("agent-coordination.marker", { sequence: 2 });
	const after = transcript.inspect();

	assert.equal(before.sessionId, "agent-1");
	assert.equal(before.transcriptPath, null);
	assert.equal(before.header?.cwd, "/workflow");
	assert.equal(before.entries.length, 1);
	assert.equal(before.activeBranch.length, 1);
	assert.equal(after.entries.length, 2);
	assert.equal(after.activeBranch.length, 2);
	assert.notEqual(before, after);
	assert.notEqual(before.entries, after.entries);
	assert.notEqual(before.activeBranch, after.activeBranch);
});

function inspection(sessionId: string, entryId: string): TranscriptInspection {
	return {
		sessionId,
		transcriptPath: null,
		header: null,
		entries: [{
			type: "custom",
			id: entryId,
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			customType: "test",
		}],
		activeBranch: [],
		context: { messages: [], thinkingLevel: "off", model: null },
	};
}
