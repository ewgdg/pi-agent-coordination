import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { MessageCoordinator, type AgentMessageInput, type MessageBoundaryHooks } from "../src/coordination/messages.ts";
import { AgentWaitCoordinator } from "../src/coordination/agent-waits.ts";
import { WorkflowPolicyStore } from "../src/policy/workflow-policy.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { inspectMessageDeliveries } from "../src/protocol/message-delivery.ts";
import type { AgentRuntimeHost, AgentRunHandle, AgentRuntimeDelivery, AgentRunEndCause } from "../src/runtime/agent-runtime-host.ts";
import { SerialLane } from "../src/runtime/serial-lane.ts";
import { participant } from "./support/request-history.ts";

test("fresh Wait restores a lost original Request after passive coordinator recovery and completes with Answer proof", async (t) => {
	const h = harness(t);
	h.responder.blocked = true;
	const receipt = await h.message(h.requester, "original", {
		operation: "request", targetAgent: "responder", question: "Need the decision before proceeding.",
		contextPreparation: { workScale: "medium", contextDependence: "high" },
	});
	assert.ok("requestMessageId" in receipt);
	const requestId = receipt.requestMessageId;
	await h.recover();
	h.responder.blocked = false;
	assert.deepEqual(h.deliveries(h.responder), [], "cold relationship recovery is passive");
	const waiting = h.wait("after-recovery");
	await flush();
	assert.deepEqual(h.deliveries(h.responder).map(item => item.projection), [{
		kind: "request", requestMessageId: requestId, fromAgentId: "requester",
		question: "Need the decision before proceeding.",
	}]);
	assert.deepEqual(h.responder.dispatches[0]?.kind === "custom" &&
		h.responder.dispatches[0].workingZonePreparation?.intent,
		{ workScale: "medium", contextDependence: "high" });
	await h.message(h.responder, "answer", { operation: "answer", requestId, answer: "Proceed." });
	await h.tick();
	const result = await waiting;
	assert.ok("answers" in result);
	assert.equal(result.answers.length, 1);
	assert.equal(result.answers[0]?.requestMessageId, requestId);
	h.commitWait("after-recovery", result);
	assert.deepEqual(h.messages.outstandingRequestIdsFor(h.requester.record), []);
	assert.equal(h.deliveries(h.responder).length, 1);
});

test("Wait coalesces a held queue, repairs loss in the same Run, and delivers only its captured Request", async (t) => {
	const h = harness(t);
	h.responder.blocked = true;
	const receipt = await h.message(h.requester, "held-request", {
		operation: "request", targetAgent: "responder", question: "Captured work.",
	});
	assert.ok("requestMessageId" in receipt);
	h.wait("held-wait");
	await flush();
	await h.tick();
	assert.equal(h.deliveries(h.responder).length, 0, "Wait respects the Hold");
	await h.responder.record.host.lane.run(() => h.messages.discardSchedulingInLane(h.responder.record));
	// Later canonical sources are deliberately not scheduled and cannot enter the fixed snapshot.
	call(h.requester, "later-request", "agent_message", {
		operation: "request", targetAgent: "responder", question: "Later unrelated work.",
	});
	h.responder.blocked = false;
	await h.tick();
	await h.tick();
	assert.deepEqual(h.deliveries(h.responder).map(d => d.projection.kind === "request" && d.projection.requestMessageId),
		[receipt.requestMessageId]);
});

test("fresh Wait may start a Dormant recipient, but a parked Wait cannot undo later termination", async (t) => {
	const h = harness(t);
	h.responder.blocked = true;
	await h.message(h.requester, "lost-request", {
		operation: "request", targetAgent: "responder", question: "Renewed work.",
	});
	h.responder.stop();
	await h.recover();
	h.wait("fresh-dormant-wait");
	await flush();
	assert.equal(h.responder.record.host.observe().phase, "live");
	assert.equal(h.deliveries(h.responder).length, 0);
	await h.responder.record.host.lane.run(() => {
		h.responder.stop();
		h.messages.discardSchedulingInLane(h.responder.record);
	});
	h.responder.blocked = false;
	await h.tick();
	await h.tick();
	assert.equal(h.responder.record.host.observe().phase, "dormant");
	assert.equal(h.deliveries(h.responder).length, 0);
});

test("cancellation during Wait suppresses lost Request scheduling and ends the join", async (t) => {
	const h = harness(t);
	h.responder.blocked = true;
	const receipt = await h.message(h.requester, "cancelled-request", {
		operation: "request", targetAgent: "responder", question: "Work no longer needed.",
	});
	assert.ok("requestMessageId" in receipt);
	const waiting = assert.rejects(h.wait("cancelled-wait"), /was cancelled/);
	await flush();
	await h.responder.record.host.lane.run(() => h.messages.discardSchedulingInLane(h.responder.record));
	await h.message(h.requester, "cancel", {
		operation: "cancel", requestMessageId: receipt.requestMessageId, reason: "Stop waiting for this work.",
	});
	h.responder.blocked = false;
	await h.tick();
	await waiting;
	assert.equal(h.deliveries(h.responder).length, 0);
});

test("delivered Requests are never replayed and committed Answers remain retrievable from a Dormant responder", async (t) => {
	const h = harness(t);
	const receipt = await h.message(h.requester, "delivered-request", {
		operation: "request", targetAgent: "responder", question: "Work already received.",
	});
	assert.ok("requestMessageId" in receipt);
	h.requester.blocked = true;
	await h.message(h.responder, "committed-answer", {
		operation: "answer", requestId: receipt.requestMessageId, answer: "Completed.",
	});
	h.responder.stop();
	await h.recover();
	const result = await h.wait("retrieve-answer");
	h.commitWait("retrieve-answer", result);
	assert.equal(h.responder.record.host.observe().phase, "dormant");
	assert.equal(h.deliveries(h.responder).length, 1);
	assert.deepEqual(h.messages.outstandingRequestIdsFor(h.requester.record), []);
});

test("a delivered unanswered Request stays awaited without starting a Dormant responder", async (t) => {
	const h = harness(t);
	await h.message(h.requester, "received-request", {
		operation: "request", targetAgent: "responder", question: "Work already received.",
	});
	h.responder.stop();
	await h.recover();
	let finished = false;
	h.wait("await-received").then(() => { finished = true; }, () => undefined);
	await flush();
	await h.tick();
	assert.equal(finished, false);
	assert.equal(h.responder.record.host.observe().phase, "dormant");
	assert.equal(h.deliveries(h.responder).length, 1);
});

test("Wait leaves a frozen original Steer Request reserved exactly once", async (t) => {
	let release: (() => Promise<void>) | undefined;
	const h = harness(t, { afterSteerFreeze(context) { release = context.release; return "defer"; } });
	await h.message(h.requester, "frozen-request", {
		operation: "request", targetAgent: "responder", question: "Reserved work.", deliveryMode: "steer",
	});
	assert.ok(release);
	h.wait("frozen-wait");
	await flush();
	await h.tick();
	await h.tick();
	assert.equal(h.deliveries(h.responder).length, 0);
	await release();
	await h.tick();
	assert.equal(h.deliveries(h.responder).length, 1);
});

test("Wait preserves a dispatched Request while recipient proof is in flight", async (t) => {
	const h = harness(t);
	h.responder.deferProof = true;
	await h.message(h.requester, "inflight-request", {
		operation: "request", targetAgent: "responder", question: "Dispatched work.",
	});
	h.wait("inflight-wait");
	await flush();
	await h.tick();
	await h.tick();
	assert.equal(h.responder.dispatches.length, 1);
	assert.equal(h.deliveries(h.responder).length, 0);
	h.responder.commitPending();
	await h.tick();
	assert.equal(h.deliveries(h.responder).length, 1);
	assert.equal(h.responder.dispatches.length, 1);
});

test("Wait fails explicitly when authoritative recipient inspection is unavailable", async (t) => {
	const h = harness(t, { beforeRecipientInspection: () => "inspection_incomplete" });
	h.responder.blocked = true;
	const receipt = await h.message(h.requester, "uninspectable-request", {
		operation: "request", targetAgent: "responder", question: "Cannot safely inspect.",
	});
	assert.ok("requestMessageId" in receipt);
	await h.recover();
	h.responder.blocked = false;
	await assert.rejects(h.wait("uninspectable-wait"), error =>
		error instanceof Error && error.message.includes(receipt.requestMessageId) &&
		error.message.includes("evidence_unavailable"));
	assert.equal(h.deliveries(h.responder).length, 0);
});

test("Wait keeps a sibling Request queued behind the responder's foreground", async (t) => {
	const h = harness(t);
	const foreground = await h.message(h.requester, "foreground-request", {
		operation: "request", targetAgent: "responder", question: "First obligation.",
	});
	assert.ok("requestMessageId" in foreground);
	const sibling = await h.message(h.requester, "sibling-request", {
		operation: "request", targetAgent: "responder", question: "Second obligation.",
	});
	assert.ok("requestMessageId" in sibling);
	h.responder.settle();
	h.wait("sibling-wait");
	await flush();
	await h.tick();
	assert.equal(h.deliveries(h.responder).length, 1, "a queued sibling is not lost scheduling");
	await h.message(h.responder, "foreground-answer", {
		operation: "answer", requestId: foreground.requestMessageId, answer: "First done.",
	});
	await h.tick();
	assert.deepEqual(h.deliveries(h.responder).map(d => d.projection.kind === "request" && d.projection.requestMessageId),
		[foreground.requestMessageId, sibling.requestMessageId]);
});

test("Answer notification completes Wait even while delivery reconciliation is queued behind a busy recipient lane", async (t) => {
	const h = harness(t);
	const request = await h.message(h.requester, "busy-recipient-request", {
		operation: "request", targetAgent: "responder", question: "Commit the Answer independently.",
	});
	assert.ok("requestMessageId" in request);
	let release!: () => void;
	const held = new Promise<void>(resolve => { release = resolve; });
	t.after(release);
	void h.responder.record.host.lane.run(() => held);
	let result: unknown;
	const waiting = h.wait("busy-lane-wait").then(value => { result = value; });
	await flush();
	// A remote Runtime's transcript append is independent of the host lane.
	const toolCallId = "remote-answer";
	const entryId = h.responder.manager.appendMessage(fauxAssistantMessage(fauxToolCall("agent_message", {
		operation: "answer", requestId: request.requestMessageId, answer: "Committed remotely.",
	}, { id: toolCallId }), { stopReason: "toolUse" }));
	commit(h.responder, toolCallId, "agent_message", {
		messageId: deriveMessageIdentity({ agentId: "responder", entryId, toolCallId }),
		requestMessageId: request.requestMessageId, messageStatus: "sent",
	});
	h.notify();
	await flush();
	assert.ok(result, "recipient scheduling must not block committed Answer retrieval");
	release();
	await waiting;
});

test("fresh Wait restores a canonical Creation Request under its Spawn identity", async (t) => {
	const h = harness(t);
	const toolCallId = "original-spawn";
	const input = { request: "Original creation work." };
	const entryId = h.requester.manager.appendMessage(fauxAssistantMessage(
		fauxToolCall("agent_spawn", input, { id: toolCallId }), { stopReason: "toolUse" },
	));
	const source = { agentId: "requester", entryId, toolCallId };
	const requestId = deriveMessageIdentity(source);
	h.responder.record.identity = {
		agentId: "responder", workflowId: "requester", directSpawnerAgentId: "requester",
		spawnSource: source, creationPreset: null, metadata: { label: "worker" },
	};
	h.responder.record.creationInput = input;
	h.responder.stop();
	await h.recover();
	const waiting = h.wait("creation-wait");
	await flush();
	assert.deepEqual(h.deliveries(h.responder).map(d => d.projection), [{
		kind: "request", requestMessageId: requestId, fromAgentId: "requester", question: input.request,
	}]);
	await h.message(h.responder, "creation-answer", { operation: "answer", requestId, answer: "Creation work done." });
	await h.tick();
	h.commitWait("creation-wait", await waiting);
	assert.deepEqual(h.messages.outstandingRequestIdsFor(h.requester.record), []);
});

test("a queued reconciliation cannot admit delivery after its caller Run is fenced", async (t) => {
	const h = harness(t);
	h.responder.blocked = true;
	await h.message(h.requester, "fenced-request", {
		operation: "request", targetAgent: "responder", question: "Do not revive fenced intent.",
	});
	await h.recover();
	let release!: () => void;
	const held = new Promise<void>(resolve => { release = resolve; });
	t.after(release);
	void h.responder.record.host.lane.run(() => held);
	const waiting = assert.rejects(h.wait("fenced-wait"), /no longer available/);
	await flush();
	h.requester.stop();
	h.responder.blocked = false;
	release();
	await waiting;
	await flush();
	assert.equal(h.deliveries(h.responder).length, 0);
});

test("one busy recipient lane does not prevent Wait from scheduling another captured Request", async (t) => {
	const h = harness(t);
	const other = h.addRecipient("other");
	h.responder.blocked = true;
	other.blocked = true;
	await h.message(h.requester, "first-recipient", {
		operation: "request", targetAgent: "responder", question: "First recipient.",
	});
	await h.message(h.requester, "other-recipient", {
		operation: "request", targetAgent: "other", question: "Other recipient.",
	});
	await h.recover();
	let release!: () => void;
	const held = new Promise<void>(resolve => { release = resolve; });
	t.after(release);
	void h.responder.record.host.lane.run(() => held);
	other.blocked = false;
	h.wait("multiple-recipient-wait");
	await flush();
	assert.equal(h.deliveries(other).length, 1);
	release();
});

test("late delivery-maintenance failure cannot replace a preempted Wait result", async (t) => {
	let h!: ReturnType<typeof harness>;
	h = harness(t, { afterDeliveryAdmission({ operation }) {
		if (operation !== "retry") return;
		void h.preempt();
		return "confirmation_lost";
	} });
	h.responder.blocked = true;
	await h.message(h.requester, "preempted-request", {
		operation: "request", targetAgent: "responder", question: "Work before redirection.",
	});
	await h.recover();
	const result = await h.wait("preempted-maintenance-wait");
	await flush();
	assert.deepEqual(result, { disposition: "preempted" });
	h.commitWait("preempted-maintenance-wait", result);
	const committed = h.requester.manager.getLeafEntry();
	assert.ok(committed?.type === "message" && committed.message.role === "toolResult");
	assert.equal(committed.message.isError, false);
	assert.deepEqual(committed.message.details, { disposition: "preempted" });
});

function harness(t: { after(fn: () => void | Promise<void>): void }, boundaryHooks?: MessageBoundaryHooks) {
	const requester = runtimeParticipant("requester");
	const responder = runtimeParticipant("responder");
	const participants = [requester, responder];
	const agents = new Map(participants.map(p => [p.record.identity.agentId, p.record]));
	const options = { agents, boundaryHooks, workflowPolicy: new WorkflowPolicyStore(), isShuttingDown: () => false };
	let messages = new MessageCoordinator(options);
	let timer: (() => void) | undefined;
	let waits: AgentWaitCoordinator;
	const abort = new AbortController();
	const pending: Promise<unknown>[] = [];
	function install() {
		for (const p of participants) messages.integrate(p.record);
		waits = new AgentWaitCoordinator({
			agents, messages,
			clock: { schedule: (_delay, callback) => { timer = callback; return () => { timer = undefined; }; } },
			suspendExecution: () => undefined, resumeExecution: async () => undefined,
		});
	}
	install();
	t.after(async () => {
		abort.abort();
		waits.shutdown();
		await Promise.allSettled(pending);
		messages.shutdownDeliveryProgress();
	});
	return {
		requester, responder,
		addRecipient(agentId: string) {
			const p = runtimeParticipant(agentId);
			participants.push(p);
			agents.set(agentId, p.record);
			messages.integrate(p.record);
			return p;
		},
		get messages() { return messages; },
		async recover() {
			waits.shutdown();
			for (const p of participants) messages.discardSchedulingInLane(p.record);
			messages.shutdownDeliveryProgress();
			messages = new MessageCoordinator(options);
			install();
			await messages.refreshTranscriptFacts();
		},
		async message(p: ReturnType<typeof runtimeParticipant>, id: string, input: AgentMessageInput) {
			call(p, id, "agent_message", input);
			const result = await messages.execute(p.record.identity.agentId, id, input);
			commit(p, id, "agent_message", result);
			return result;
		},
		wait(id: string) {
			call(requester, id, "agent_wait", {});
			const result = waits.wait("requester", id, {}, abort.signal);
			pending.push(result);
			return result;
		},
		commitWait(id: string, result: unknown) {
			const message = {
				role: "toolResult" as const, toolCallId: id, toolName: "agent_wait",
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
				details: result, isError: false, timestamp: Date.now(),
			};
			const committed = waits.guardResultCommit("requester", message)?.message ?? message;
			if (committed.role !== "toolResult") throw new Error("Expected a Wait tool result");
			requester.manager.appendMessage(committed);
			waits.reconcileCommittedResults("requester");
		},
		preempt() { return waits.preemptForHumanInput(requester.record); },
		async tick() { timer?.(); await flush(); },
		notify() { waits.reconcileCommittedAnswers(); },
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
		...p, blocked: false, deferProof: false,
		commitPending() { for (const commit of proofCommits.splice(0)) commit(); },
		settle() { if (handle) for (const handler of settled) handler(handle, "settled"); },
		dispatches: [] as AgentRuntimeDelivery[],
		stop() {
			const previous = handle;
			handle = undefined;
			if (previous) for (const handler of ended) handler(previous, "termination");
		},
	};
	p.record.host = {
		lane: new SerialLane(),
		currentHandle: () => handle, latestStartedRunSequence: () => sequence,
		isCurrent: (candidate: AgentRunHandle) => candidate === handle,
		startInLane: async () => { handle = { sequence: ++sequence }; return handle; },
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
		observe: () => handle ? { phase: "live", work: attention === "agent_wait" ? "active" : "settled", attention, retentionReasons: [] } : { phase: "dormant", retentionReasons: [] },
		beginAgentWait: () => { attention = "agent_wait"; },
		endAgentWait: () => { attention = "none"; },
		currentRunFailed: () => false,
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
