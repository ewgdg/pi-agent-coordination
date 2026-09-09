import { AgentTranscript } from "../src/transcript/agent-transcript.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { MessageCoordinator, type AgentMessageInput } from "../src/coordination/messages.ts";
import { WorkflowPolicyStore } from "../src/policy/workflow-policy.ts";
import { inspectMessageDeliveries } from "../src/protocol/message-delivery.ts";
import type { AgentRuntimeHost, AgentRunHandle, AgentRuntimeDelivery, AgentRunEndCause } from "../src/runtime/agent-runtime-host.ts";
import { SerialLane } from "../src/runtime/serial-lane.ts";
import { participant } from "./support/request-history.ts";


import { resumeWorkflow } from "../src/coordination/workflow-resume.ts";
import type { WorkflowResumeActivation } from "../src/protocol/workflow-resume.ts";

test("recovery schedules original Requests and Messages once, preserving context preparation", { timeout: 5_000 }, async t => {
	const h = harness(t);
	h.responder.blocked = true;
	const request = await h.message(h.requester, "request", { operation: "request", targetAgent: "responder", question: "Original", contextPreparation: { workScale: "medium", contextDependence: "high" } });
	const message = await h.message(h.requester, "message", { operation: "send", targetAgent: "responder", content: "Original message" });
	await h.recover();
	h.responder.blocked = false;
	const receipt = await h.resume();
	await flush();
	assert.equal(receipt.deliveries.filter(item => item.disposition === "scheduled").length, 2);
	h.responder.settle();
	await flush();
	assert.equal(h.deliveries(h.responder).length, 2);
	assert.deepEqual(h.responder.dispatches[0]?.kind === "custom" && h.responder.dispatches[0].workingZonePreparation?.intent, { workScale: "medium", contextDependence: "high" });
	await h.resume();
	assert.equal(h.deliveries(h.responder).length, 2);
	assert.ok("requestMessageId" in request && "messageId" in message);
	assert.deepEqual(h.deliveries(h.responder).map(item => item.source.toolCallId), ["request", "message"]);
});

test("recovery sends a committed Answer to its original requester and does not activate completed work", { timeout: 5_000 }, async t => {
	const h = harness(t);
	const request = await h.message(h.requester, "request", { operation: "request", targetAgent: "responder", question: "Original" });
	assert.ok("requestMessageId" in request);
	h.requester.blocked = true;
	const answer = await h.message(h.responder, "answer", { operation: "answer", requestId: request.requestMessageId, answer: "Completed" });
	h.responder.stop();
	await h.recover();
	h.requester.blocked = false;
	const receipt = await h.resume();
	await flush();
	assert.equal(receipt.activations.length, 0);
	assert.equal(h.responder.record.host.observe().phase, "dormant");
	assert.deepEqual(h.deliveries(h.requester).map(item => item.projection.kind), ["answer"]);
	assert.ok("messageId" in answer);
	assert.ok(receipt.deliveries.some(item => item.messageId === answer.messageId && item.targetAgentId === "requester" && item.disposition === "scheduled"));
});

test("recovery coalesces held scheduling and suppresses cancelled Requests before dispatch", { timeout: 5_000 }, async t => {
	const h = harness(t);
	h.responder.blocked = true;
	const request = await h.message(h.requester, "request", { operation: "request", targetAgent: "responder", question: "Original" });
	assert.ok("requestMessageId" in request);
	const receipt = await h.resume();
	assert.ok(receipt.deliveries.some(item => item.reason === "already_scheduled"));
	assert.equal(h.deliveries(h.responder).length, 0);
	await h.message(h.requester, "cancel", { operation: "cancel", requestMessageId: request.requestMessageId, reason: "No longer needed" });
	await h.recover();
	h.responder.blocked = false;
	const cancelled = await h.resume();
	assert.ok(cancelled.deliveries.some(item => item.messageId === request.requestMessageId && item.reason === "request_resolved"));
	assert.equal(h.deliveries(h.responder).filter(item => item.projection.kind === "request").length, 0);
});

test("snapshot excludes work authored during recovery admission and does not infer ordinary Message continuations", { timeout: 5_000 }, async t => {
	const h = harness(t);
	h.responder.blocked = true;
	await h.message(h.requester, "initial", { operation: "send", targetAgent: "responder", content: "Initial" });
	await h.recover();
	const original = h.messages.resumeMessage.bind(h.messages);
	h.messages.resumeMessage = async message => {
		const result = await original(message);
		await h.message(h.requester, "later", { operation: "send", targetAgent: "responder", content: "Later" });
		return result;
	};
	const receipt = await h.resume();
	assert.equal(receipt.deliveries.length, 1);
	assert.equal(receipt.activations.length, 0);
});

test("unavailable Workflow evidence is explicit and independent work can still be recovered", { timeout: 5_000 }, async t => {
	const h = harness(t);
	h.responder.blocked = true;
	await h.message(h.requester, "initial", { operation: "send", targetAgent: "responder", content: "Initial" });
	await h.recover();
	const receipt = await h.resume(new Set(["missing-agent"]));
	assert.deepEqual(receipt.indeterminate, [{ agentId: "missing-agent", reason: "evidence_unavailable: quarantined Agent transcript" }]);
	assert.equal(receipt.deliveries[0]?.disposition, "scheduled");
});


test("nested recovery retains foreground and suspended obligations from the original delegation chain", { timeout: 5_000 }, async t => {
	const h = harness(t);
	const first = await h.message(h.requester, "first", { operation: "request", targetAgent: "responder", question: "Outer work" });
	const reverse = await h.message(h.responder, "reverse", { operation: "request", targetAgent: "requester", question: "Need a decision" });
	h.responder.settle();
	h.requester.settle();
	await flush();
	const nested = await h.message(h.requester, "nested", { operation: "request", targetAgent: "responder", question: "Clarify before decision" });
	assert.ok("requestMessageId" in first && "requestMessageId" in reverse && "requestMessageId" in nested);
	h.responder.stop();
	await h.recover();
	const receipt = await h.resume();
	assert.deepEqual(receipt.activations.find(item => item.agentId === "responder")?.requestIds, [first.requestMessageId, nested.requestMessageId]);
	assert.deepEqual(receipt.activations.find(item => item.agentId === "requester")?.requestIds, [reverse.requestMessageId]);
	assert.deepEqual(h.messages.outstandingRequestIdsFor(h.responder.record), [], "outer dependency remains suspended, not foreground");
	assert.equal(h.deliveries(h.responder).length, 2);
});


test("concurrent resume calls coalesce admission and report pending capacity explicitly", { timeout: 5_000 }, async t => {
	const h = harness(t);
	h.responder.blocked = true;
	await h.message(h.requester, "first", { operation: "send", targetAgent: "responder", content: "First" });
	await h.message(h.requester, "second", { operation: "send", targetAgent: "responder", content: "Second" });
	await h.recover();
	h.policy.publish(Object.freeze({ ...h.policy.current(), maxPendingDeliveriesPerAgent: 1 }));
	const receipts = await Promise.all([h.resume(), h.resume()]);
	assert.equal(receipts.flatMap(item => item.deliveries).filter(item => item.disposition === "scheduled").length, 1);
	assert.ok(receipts.flatMap(item => item.deliveries).some(item => item.reason === "already_scheduled"));
	assert.ok(receipts.every(item => item.deliveries.some(delivery => delivery.disposition === "blocked" && delivery.reason === "capacity_exhausted")));
	assert.equal(h.deliveries(h.responder).length, 0);
});


test("cancellation committed after the snapshot suppresses stale delivery admission", { timeout: 5_000 }, async t => {
	const h = harness(t);
	h.responder.blocked = true;
	const request = await h.message(h.requester, "request", { operation: "request", targetAgent: "responder", question: "Original" });
	assert.ok("requestMessageId" in request);
	await h.recover();
	const original = h.messages.resumeMessage.bind(h.messages);
	h.messages.resumeMessage = async message => {
		await h.message(h.requester, "cancel-during-resume", { operation: "cancel", requestMessageId: request.requestMessageId, reason: "Cancellation won" });
		return original(message);
	};
	const receipt = await h.resume();
	assert.deepEqual(receipt.deliveries.map(item => [item.disposition, item.reason]), [["skipped", "request_resolved"]]);
	assert.equal(h.deliveries(h.responder).length, 0);
});


test("a dormant Agent with only delivered ordinary Messages is not proactively restarted", { timeout: 5_000 }, async t => {
	const h = harness(t);
	await h.message(h.requester, "ordinary", { operation: "send", targetAgent: "responder", content: "Historical ordinary Message" });
	h.responder.stop();
	await h.recover();
	const receipt = await h.resume();
	assert.equal(receipt.activations.length, 0);
	assert.equal(h.responder.record.host.observe().phase, "dormant");
	assert.deepEqual(receipt.deliveries.map(item => [item.disposition, item.reason]), [["skipped", "delivered"]]);
});


test("a failed durable transcript read is indeterminate rather than guessed as undelivered work", { timeout: 5_000 }, async t => {
	const h = harness(t);
	h.responder.blocked = true;
	await h.message(h.requester, "unavailable", { operation: "request", targetAgent: "responder", question: "Need verified proof" });
	await h.recover();
	h.responder.record.transcript = new AgentTranscript({ read() { throw new Error("evidence_unavailable: unreadable transcript"); } });
	const receipt = await h.resume();
	assert.ok(receipt.indeterminate.some(item => item.agentId === "responder" && item.reason.includes("unreadable transcript")));
	assert.equal(receipt.deliveries.length, 0);
	assert.equal(receipt.activations.length, 0);
	assert.equal(h.responder.dispatches.length, 0);
});

function harness(t: { after(fn: () => void | Promise<void>): void }) {
	const requester = runtimeParticipant("requester");
	const responder = runtimeParticipant("responder");
	const participants = [requester, responder];
	const agents = new Map(participants.map(p => [p.record.identity.agentId, p.record]));
	const options = { agents, workflowPolicy: new WorkflowPolicyStore(), isShuttingDown: () => false };
	let messages = new MessageCoordinator(options);
	for (const p of participants) messages.integrate(p.record);
	t.after(() => messages.shutdownDeliveryProgress());
	return {
		requester, responder, policy: options.workflowPolicy,
		get messages() { return messages; },
		async recover() {
			for (const p of participants) messages.discardSchedulingInLane(p.record);
			messages.shutdownDeliveryProgress();
			messages = new MessageCoordinator(options);
			for (const p of participants) messages.integrate(p.record);
			await messages.refreshTranscriptFacts();
		},
		async message(p: ReturnType<typeof runtimeParticipant>, id: string, input: AgentMessageInput) {
			call(p, id, "agent_message", input);
			const result = await messages.execute(p.record.identity.agentId, id, input);
			commit(p, id, "agent_message", result);
			await flush();
			return result;
		},
		resume(quarantinedAgentIds = new Set<string>()) {
			return resumeWorkflow({
				workflowId: "requester", agents, messages, quarantinedAgentIds,
				activate: async (record, requestIds): Promise<WorkflowResumeActivation> => ({
					agentId: record.identity.agentId, requestIds, disposition: "skipped", reason: "running",
				}),
			});
		},
		deliveries(p: ReturnType<typeof runtimeParticipant>) {
			return inspectMessageDeliveries({ recipientAgentId: p.record.identity.agentId, transcript: p.record.transcript.inspect() });
		},
	};
}
// Adapt only the Runtime Host: delivery appends real recipient transcript proof.
function runtimeParticipant(agentId: string) {
	const p = participant(agentId);
	let handle: AgentRunHandle | undefined = { sequence: 1 };
	let sequence = 1;
	let attention: "none" | "agent_wait" = "none";
	const ended = new Set<(handle: AgentRunHandle, cause: AgentRunEndCause) => void>();
	const proofCommits: (() => void)[] = [];
	const settled = new Set<(handle: AgentRunHandle, state: "settled") => void>();
	const runtime = {
		...p, blocked: false, deferProof: false, ending: false, failed: false,
		commitPending() { for (const commit of proofCommits.splice(0)) commit(); },
		settle() { if (handle) for (const handler of settled) handler(handle, "settled"); },
		dispatches: [] as AgentRuntimeDelivery[],
		stop(cause: AgentRunEndCause = "termination") {
			const previous = handle;
			handle = undefined;
			if (previous) for (const handler of ended) handler(previous, cause);
		},
	};
	p.record.host = {
		lane: new SerialLane(),
		currentHandle: () => handle, latestStartedRunSequence: () => sequence,
		isCurrent: (candidate: AgentRunHandle) => candidate === handle,
		startInLane: async () => {
			runtime.ending = false;
			runtime.failed = false;
			handle = { sequence: ++sequence };
			return handle;
		},
		setRunStartInitializer: () => undefined,
		addSettledHandler: (handler: (handle: AgentRunHandle, state: "settled") => void) => {
			settled.add(handler); return () => { settled.delete(handler); };
		},
		finishIsolatedResumptionInLane: () => undefined,
		releaseIfEligibleInLane: () => "retained",
		addEndedHandler: (handler: (handle: AgentRunHandle, cause: AgentRunEndCause) => void) => {
			ended.add(handler); return () => { ended.delete(handler); };
		},
		addRetentionReason: () => undefined, removeRetentionReason: () => undefined,
		hasRetentionReason: () => false,
		blocksOrdinaryDelivery: () => runtime.blocked,
		currentWorkState: () => attention === "agent_wait" ? "active" : "settled",
		observe: () => handle ? { phase: runtime.ending ? "ending" : "live", work: attention === "agent_wait" ? "active" : "settled", attention, retentionReasons: [] } : { phase: "dormant", retentionReasons: [] },
		beginAgentWait: () => { attention = "agent_wait"; },
		endAgentWait: () => { attention = "none"; },
		currentRunFailed: () => handle !== undefined && runtime.failed,
		deliverInLane: (input: AgentRuntimeDelivery) => {
			runtime.dispatches.push(input);
			if (input.kind !== "custom") throw new Error("Expected coordination Delivery");
			const m = input.message;
			const append = () => p.manager.appendCustomMessageEntry(m.customType, m.content, m.display, "details" in m ? m.details : undefined);
			if (runtime.deferProof) return { completion: new Promise<void>(resolve => {
				proofCommits.push(() => { append(); resolve(); });
			}) };
			append();
			return { completion: Promise.resolve() };
		},
	} as unknown as AgentRuntimeHost;
	return runtime;
}
function call(p: ReturnType<typeof participant>, id: string, name: string, input: Record<string, unknown>) {
	p.manager.appendMessage(fauxAssistantMessage(fauxToolCall(name, input, { id }), { stopReason: "toolUse" }));
}
function commit(p: ReturnType<typeof participant>, id: string, name: string, details: unknown) {
	p.manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: JSON.stringify(details) }], details, isError: false, timestamp: Date.now() });
}
async function flush() { for (let i = 0; i < 8; i++) await setImmediate(); }
