import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { RequestEvidence } from "../src/coordination/request-evidence.ts";
import { createMessageDelivery } from "../src/protocol/message-delivery.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { requestHistory } from "./support/request-history.ts";

test("reverse Request ancestry follows the latest delivered attention", () => {
	const h = requestHistory();
	const root = h.request();
	const toolCallId = "reverse";
	const entryId = h.responder.manager.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message", {
		operation: "request", targetAgent: "requester", question: "Clarify",
	}, { id: toolCallId }), { stopReason: "toolUse" }));
	const source = { agentId: "responder", entryId, toolCallId };
	const reverse = deriveMessageIdentity(source);
	const delivery = createMessageDelivery([{ source, projection: {
		kind: "request", requestMessageId: reverse, fromAgentId: "responder", question: "Clarify",
	} }]);
	h.requester.manager.appendCustomMessageEntry(delivery.customType, delivery.content, true, delivery.details);
	const nested = h.request();
	const evidence = new RequestEvidence(h.agents);
	assert.equal(evidence.parentRequestId(reverse), root);
	assert.equal(evidence.parentRequestId(nested), reverse);
	assert.equal(evidence.obligationFrames(h.responder.record).at(-1)?.requestId, nested);
	h.answer(nested);
	assert.equal(evidence.obligationFrames(h.responder.record).at(-1)?.requestId, root);
});

test("Answers require an explicit Request reference", async () => {
	const { validateAgentMessageInput } = await import("../src/protocol/agent-message-input.ts");
	assert.deepEqual(validateAgentMessageInput({ operation: "answer", requestId: "request-suffix", answer: "Done" }),
		{ operation: "answer", requestId: "request-suffix", answer: "Done" });
	assert.throws(() => validateAgentMessageInput({ operation: "answer", answer: "Done" }), /invalid_input/);
});

test("Wait captures Agent-owned dependencies regardless of incoming attention", () => {
	const h = requestHistory();
	const root = h.request();
	const parentDependency = h.request(h.responder, h.requester);
	const nested = h.request();
	const evidence = new RequestEvidence(h.agents);
	const waitSource = (id: string) => ({ agentId: "responder", toolCallId: id,
		entryId: h.responder.manager.appendMessage(fauxAssistantMessage(fauxToolCall("agent_wait", {}, { id }), { stopReason: "toolUse" })) });
	assert.deepEqual(evidence.outstandingRequestIdsAt(h.responder.record, waitSource("nested-empty-wait")), [parentDependency]);
	const nestedDependency = h.request(h.responder, h.requester);
	assert.deepEqual(evidence.outstandingRequestIdsAt(h.responder.record, waitSource("nested-wait")), [parentDependency, nestedDependency]);
	h.answer(nestedDependency, h.requester, h.responder);
	h.answer(nested);
	assert.equal(evidence.obligationFrames(h.responder.record).at(-1)?.requestId, root);
	assert.deepEqual(evidence.outstandingRequestIdsAt(h.responder.record, waitSource("restored-wait")), [parentDependency]);
});

test("attention history survives native transcript reopen and compaction", async () => {
	const { mkdtemp } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { SessionManager } = await import("@earendil-works/pi-coding-agent");
	const { transcriptFromSessionManager } = await import("../src/pi-integration/session-manager-transcript.ts");
	const h = requestHistory();
	const root = h.request();
	h.request(h.responder, h.requester);
	const second = h.request();
	h.request(h.responder, h.requester);
	const third = h.request();
	const dir = await mkdtemp(join(tmpdir(), "causal-stack-"));
	const { writeFile } = await import("node:fs/promises");
	for (const agent of [h.requester, h.responder]) {
		const path = join(dir, `${agent.record.identity.agentId}.jsonl`);
		const entries = agent.manager.getEntries();
		agent.manager.appendCompaction("Compact ordinary conversation", entries.at(-1)!.id, 100);
		await writeFile(path, [agent.manager.getHeader(), ...agent.manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n");
		agent.record.transcript = transcriptFromSessionManager(SessionManager.open(path));
	}
	const reopened = new RequestEvidence(h.agents);
	assert.equal(reopened.obligationFrames(h.responder.record).at(-1)?.requestId, third);
	assert.equal(reopened.parentRequestId(third), reopened.obligationFrames(h.requester.record).at(-1)?.requestId);
	// Continue the same retained histories after proving cold reconstruction.
	h.responder.record.transcript = transcriptFromSessionManager(h.responder.manager);
	h.requester.record.transcript = transcriptFromSessionManager(h.requester.manager);
	h.answer(third);
	assert.equal(reopened.obligationFrames(h.responder.record).at(-1)?.requestId, second);
	h.answer(second);
	assert.equal(reopened.obligationFrames(h.responder.record).at(-1)?.requestId, root);
});

for (const cancelLatest of [true, false]) test(`cancelling a ${cancelLatest ? "latest" : "earlier"} obligation retains other incoming work and outgoing dependencies`, () => {
	const h = requestHistory();
	const root = h.request();
	const dependency = h.request(h.responder, h.requester);
	const nested = h.request();
	const nestedDependency = h.request(h.responder, h.requester);
	const cancelled = cancelLatest ? nested : root;
	const id = "cancel-frame";
	const source = { agentId: "requester", toolCallId: id, entryId: h.requester.manager.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message", {
		operation: "cancel", requestMessageId: cancelled, reason: "Withdraw this frame",
	}, { id }), { stopReason: "toolUse" })) };
	const cancellation = createMessageDelivery([{ source, projection: { kind: "request_cancellation",
		cancellationId: deriveMessageIdentity(source), requestMessageId: cancelled, fromAgentId: "requester", reason: "Withdraw this frame" } }]);
	h.responder.manager.appendCustomMessageEntry(cancellation.customType, cancellation.content, true, cancellation.details);
	const evidence = new RequestEvidence(h.agents);
	assert.equal(evidence.obligationFrames(h.responder.record).at(-1)?.requestId, cancelLatest ? root : nested);
	assert.deepEqual(evidence.outstandingRequestIdsFor(h.responder.record), [dependency, nestedDependency]);
});

test("cold focus recognizes an Answer delivered before its responder result appended", async () => {
	const { mkdtemp, writeFile } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { SessionManager } = await import("@earendil-works/pi-coding-agent");
	const { transcriptFromSessionManager } = await import("../src/pi-integration/session-manager-transcript.ts");
	const h = requestHistory();
	const root = h.request();
	h.request(h.responder, h.requester);
	const nested = h.request();
	h.answer(nested);
	const path = join(await mkdtemp(join(tmpdir(), "interrupted-answer-")), "responder.jsonl");
	await writeFile(path, [h.responder.manager.getHeader(), ...h.responder.manager.getEntries().slice(0, -1)].map(entry => JSON.stringify(entry)).join("\n") + "\n");
	h.responder.record.transcript = transcriptFromSessionManager(SessionManager.open(path));
	const recovered = new RequestEvidence(h.agents);
	assert.ok(recovered.findAnswer(recovered.requireRequest(nested)));
	assert.deepEqual(recovered.residualRelationshipsFor(h.responder.record).answerOwedRequestIds, [root]);
	assert.equal(recovered.obligationFrames(h.responder.record).at(-1)?.requestId, root);
});

test("startup persists recovered focus before new Request ancestry is authored", async () => {
	const { SessionManager } = await import("@earendil-works/pi-coding-agent");
	const { registerParticipantLifecycle } = await import("../src/pi-integration/participant-lifecycle.ts");
	const { transcriptFromSessionManager } = await import("../src/pi-integration/session-manager-transcript.ts");
	const { mkdtemp, writeFile } = await import("node:fs/promises");
	const { join } = await import("node:path");
	const { tmpdir } = await import("node:os");
	const h = requestHistory();
	const root = h.request();
	h.request(h.responder, h.requester);
	const nested = h.request();
	h.answer(nested);
	const path = join(await mkdtemp(join(tmpdir(), "recovered-focus-")), "responder.jsonl");
	await writeFile(path, [h.responder.manager.getHeader(), ...h.responder.manager.getEntries().slice(0, -1)].map(entry => JSON.stringify(entry)).join("\n") + "\n");
	h.responder.manager = SessionManager.open(path);
	h.responder.record.transcript = transcriptFromSessionManager(h.responder.manager);
	const evidence = new RequestEvidence(h.agents);
	const handlers = new Map<string, Function>();
	registerParticipantLifecycle({
		on: (name: string, handler: Function) => handlers.set(name, handler),
		appendEntry: (type: string, data: unknown) => h.responder.manager.appendCustomEntry(type, data),
	} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI, {
		executionStarted: async () => evidence.obligationFrames(h.responder.record),
	} as import("../src/pi-integration/participant-lifecycle.ts").ParticipantLifecycleHandlers);
	await handlers.get("agent_start")!({}, { sessionManager: h.responder.manager });
	const presented = await handlers.get("context")!({ messages: [] }, { sessionManager: h.responder.manager });
	assert.match(JSON.stringify(presented.messages), new RegExp(root));
	const dependency = h.request(h.responder, h.requester);
	assert.equal(evidence.parentRequestId(dependency), root);
	h.responder.record.transcript = transcriptFromSessionManager(SessionManager.open(path));
	assert.equal(new RequestEvidence(h.agents).parentRequestId(dependency), root);
});
