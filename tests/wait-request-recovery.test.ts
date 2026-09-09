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

test("a delivered Request does not consume fresh Wait admission for its undelivered sibling on a Dormant responder", async (t) => {
	const h = harness(t);
	const first = await h.message(h.requester, "delivered-before-stop", {
		operation: "request", targetAgent: "responder", question: "First obligation was delivered.",
	});
	const sibling = await h.message(h.requester, "queued-before-stop", {
		operation: "request", targetAgent: "responder", question: "Sibling still needs delivery.",
	});
	assert.ok("requestMessageId" in first && "requestMessageId" in sibling);
	assert.equal(h.deliveries(h.responder).length, 1);
	h.responder.stop();
	await h.recover();
	const waiting = h.wait("renew-mixed-delivery-snapshot");
	await flush();
	assert.equal(h.responder.record.host.observe().phase, "live",
		"inspecting delivered work must leave dormant admission available for its sibling");
	assert.equal(h.deliveries(h.responder).length, 1,
		"the sibling stays causally queued behind the delivered foreground");
	await h.message(h.responder, "first-answer-after-stop", {
		operation: "answer", requestId: first.requestMessageId, answer: "First obligation completed.",
	});
	await h.tick();
	assert.deepEqual(h.deliveries(h.responder).map(delivery =>
		delivery.projection.kind === "request" && delivery.projection.requestMessageId),
		[first.requestMessageId, sibling.requestMessageId]);
	await h.message(h.responder, "sibling-answer-after-stop", {
		operation: "answer", requestId: sibling.requestMessageId, answer: "Sibling completed.",
	});
	await h.tick();
	h.commitWait("renew-mixed-delivery-snapshot", await waiting);
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
	const waiting = h.wait("creation-wait", { requestMessageIds: [requestId.slice(-12)] });
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

for (const busyAtEntry of [true, false]) {
	test(`Wait keeps recovering other recipients while a lane is busy ${busyAtEntry ? "from entry" : "from a later timer pass"}`, async (t) => {
		const h = harness(t);
		const other = h.addRecipient("other");
		h.responder.blocked = true;
		other.blocked = true;
		await h.message(h.requester, "busy-request", {
			operation: "request", targetAgent: "responder", question: "Busy recipient.",
		});
		const first = await h.message(h.requester, "other-first", {
			operation: "request", targetAgent: "other", question: "Other recipient's first work.",
		});
		const sibling = await h.message(h.requester, "other-sibling", {
			operation: "request", targetAgent: "other", question: "Other recipient's sibling.",
		});
		assert.ok("requestMessageId" in first && "requestMessageId" in sibling);
		await h.recover();
		let release!: () => void;
		const held = new Promise<void>(resolve => { release = resolve; });
		t.after(release);
		const holdLane = () => { void h.responder.record.host.lane.run(() => held); };
		if (busyAtEntry) holdLane();
		h.wait("recurring-recovery-wait");
		await flush();
		if (!busyAtEntry) holdLane();
		await other.record.host.lane.run(() => h.messages.discardSchedulingInLane(other.record));
		other.blocked = false;
		await h.tick();
		assert.deepEqual(h.deliveries(other).map(delivery =>
			delivery.projection.kind === "request" && delivery.projection.requestMessageId),
			[first.requestMessageId], "a busy recipient cannot suppress another recipient's recovery pass");

		// The busy lane also cannot stop later timer passes after a second loss.
		await other.record.host.lane.run(() => h.messages.discardSchedulingInLane(other.record));
		await h.message(other, "other-first-answer", {
			operation: "answer", requestId: first.requestMessageId, answer: "First work completed.",
		});
		await h.tick();
		assert.deepEqual(h.deliveries(other).map(delivery =>
			delivery.projection.kind === "request" && delivery.projection.requestMessageId),
			[first.requestMessageId, sibling.requestMessageId]);
		assert.equal(h.deliveries(h.responder).length, 0);
		release();
	});
}

for (const transition of ["ending", "failure", "replacement"] as const) {
	test(`ongoing Wait respects recipient ${transition}; only a fresh Wait renews delivery intent`, async (t) => {
		const h = harness(t);
		h.responder.blocked = true;
		const receipt = await h.message(h.requester, "request-before-lifecycle-change", {
			operation: "request", targetAgent: "responder", question: "Keep the original delivery identity.",
		});
		assert.ok("requestMessageId" in receipt);
		const waiting = h.wait("wait-before-lifecycle-change");
		await flush();
		await h.responder.record.host.lane.run(async () => {
			h.messages.discardSchedulingInLane(h.responder.record);
			if (transition === "ending") h.responder.ending = true;
			if (transition === "failure") h.responder.failed = true;
			if (transition === "replacement") {
				h.responder.stop();
				await h.responder.record.host.startInLane();
			}
		});
		h.responder.blocked = false;
		await h.tick();
		await h.tick();
		assert.equal(h.deliveries(h.responder).length, 0);
		if (transition !== "replacement") {
			h.responder.stop(transition === "failure" ? "failure" : "termination");
			await h.tick();
			assert.equal(h.responder.record.host.observe().phase, "dormant");
			assert.equal(h.deliveries(h.responder).length, 0);
		}
		await h.preempt();
		h.commitWait("wait-before-lifecycle-change", await waiting);
		h.wait("fresh-wait-after-lifecycle-change");
		await flush();
		assert.equal(h.responder.record.host.observe().phase, "live");
		assert.deepEqual(h.deliveries(h.responder).map(delivery =>
			delivery.projection.kind === "request" && delivery.projection.requestMessageId),
			[receipt.requestMessageId]);
	});
}

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

for (const answerLatestFirst of [false, true]) test(`delivered Requests can be answered ${answerLatestFirst ? "latest" : "earlier"} first`, { timeout: 5_000 }, async (t) => {
	const h = harness(t);
	const first = await h.message(h.requester, "first", { operation: "request", targetAgent: "responder", question: "First" });
	h.responder.settle();
	await flush();
	const second = await h.message(h.requester, "second", { operation: "request", targetAgent: "responder", question: "Second", deliveryMode: "steer" });
	assert.ok("requestMessageId" in first && "requestMessageId" in second);
	await h.tick();
	assert.deepEqual(h.deliveries(h.responder).map(d => d.projection.kind === "request" && d.projection.requestMessageId), [first.requestMessageId, second.requestMessageId]);
	const [answered, remaining] = answerLatestFirst ? [second.requestMessageId, first.requestMessageId] : [first.requestMessageId, second.requestMessageId];
	const input = { operation: "answer" as const, requestId: answered, answer: "First done" };
	const receipt = await h.message(h.responder, "answer-first", input);
	assert.ok("messageStatus" in receipt);
	assert.deepEqual(h.messages.answerObligationRequestIds(h.responder.record), [remaining]);
	const replay = await h.messages.execute("responder", "answer-first", input);
	assert.ok("disposition" in replay && replay.disposition === "already_answered");
	await assert.rejects(h.message(h.responder, "fresh-stale-answer", input), /already answered/);
	await h.message(h.responder, "answer-second", { operation: "answer", requestId: remaining, answer: "Second done" });
	assert.deepEqual(h.messages.answerObligationRequestIds(h.responder.record), []);
});

test("explicit Wait selects suffixes, deduplicates in source order and leaves unselected Requests outstanding", { timeout: 5_000 }, async (t) => {
	const h = harness(t, { beforeDeliveryAdmission: ({ operation }) => operation === "answer" ? "confirmed_failure" : undefined });
	const ids: string[] = [];
	for (const id of ["one", "two", "three"]) {
		const receipt = await h.message(h.requester, id, { operation: "request", targetAgent: "responder", question: id, deliveryMode: "steer" });
		assert.ok("requestMessageId" in receipt);
		ids.push(receipt.requestMessageId);
	}
	await h.message(h.responder, "answer-three", { operation: "answer", requestId: ids[2]!, answer: "Three" });
	await h.message(h.responder, "answer-one", { operation: "answer", requestId: ids[0]!, answer: "One" });
	const result = await h.wait("selected", { requestMessageIds: [ids[2]!.slice(-12), ids[0]!, ids[2]!] });
	assert.ok("answers" in result);
	assert.deepEqual(result.answers.map(a => a.requestMessageId), [ids[0], ids[2]]);
	h.commitWait("selected", result);
	assert.deepEqual(h.messages.outstandingRequestIdsFor(h.requester.record), [ids[1]]);
	await assert.rejects(h.wait("consumed", { requestMessageIds: [ids[0]!] }), /not outstanding/);
});

test("explicit Wait rejects all invalid selections before renewing any Request delivery", { timeout: 5_000 }, async (t) => {
	const h = harness(t);
	h.responder.blocked = true;
	const request = await h.message(h.requester, "lost", { operation: "request", targetAgent: "responder", question: "Lost" });
	assert.ok("requestMessageId" in request);
	for (const input of [{ requestMessageIds: [] }, { requestMessageIds: [" "] }, { requestMessageIds: [request.requestMessageId, "unknown-suffix"] }]) {
		await assert.rejects(h.wait("invalid-" + JSON.stringify(input), input), /invalid_input|unknown_identity/);
		assert.deepEqual(h.deliveries(h.responder), []);
	}
	const ordinary = await h.message(h.requester, "ordinary", { operation: "send", targetAgent: "responder", content: "Hello" });
	assert.ok("messageId" in ordinary);
	await assert.rejects(h.wait("wrong-kind", { requestMessageIds: [ordinary.messageId] }), /wrong_message_kind/);
	const foreign = await h.message(h.responder, "foreign", { operation: "request", targetAgent: "requester", question: "Foreign" });
	assert.ok("requestMessageId" in foreign);
	await assert.rejects(h.wait("foreign-selection", { requestMessageIds: [foreign.requestMessageId] }), /wrong_participant/);
	await h.message(h.requester, "cancel-lost", { operation: "cancel", requestMessageId: request.requestMessageId, reason: "Withdraw" });
	await assert.rejects(h.wait("cancelled-selection", { requestMessageIds: [request.requestMessageId] }), /not outstanding/);
});

test("queued Steer Requests form an admission-ordered batch past a blocked Deferred head", { timeout: 5_000 }, async (t) => {
	const h = harness(t);
	await h.message(h.requester, "initial", { operation: "request", targetAgent: "responder", question: "Initial", deliveryMode: "steer" });
	h.responder.blocked = true;
	const deferred = await h.message(h.requester, "deferred-head", { operation: "request", targetAgent: "responder", question: "Deferred" });
	const ids: string[] = [];
	for (const id of ["steer-one", "steer-two"]) {
		const receipt = await h.message(h.requester, id, { operation: "request", targetAgent: "responder", question: id, deliveryMode: "steer" });
		assert.ok("requestMessageId" in receipt);
		ids.push(receipt.requestMessageId);
	}
	h.responder.blocked = false;
	h.responder.settle();
	await flush();
	const lastDispatch = h.responder.dispatches.at(-1);
	assert.ok(lastDispatch?.kind === "custom" && typeof lastDispatch.message.content === "string");
	assert.deepEqual(JSON.parse(lastDispatch.message.content).messages.map((message: { requestMessageId: string }) => message.requestMessageId), ids);
	assert.ok("requestMessageId" in deferred);
	assert.equal(h.deliveries(h.responder).filter(d => d.projection.kind === "request" && d.projection.requestMessageId === deferred.requestMessageId).length, 0);
	h.responder.settle();
	await flush();
	assert.equal(h.deliveries(h.responder).length, 3, "Steer batch must not redeliver at the next boundary");
});

test("Answer rejects unknown, undelivered, cancelled and wrong-responder Requests", { timeout: 5_000 }, async (t) => {
	const h = harness(t);
	h.responder.blocked = true;
	const request = await h.message(h.requester, "undelivered", { operation: "request", targetAgent: "responder", question: "Pending" });
	assert.ok("requestMessageId" in request);
	await assert.rejects(h.message(h.responder, "answer-undelivered", { operation: "answer", requestId: request.requestMessageId, answer: "Invalid" }), /has not been delivered/);
	await assert.rejects(h.message(h.requester, "answer-wrong-responder", { operation: "answer", requestId: request.requestMessageId, answer: "Invalid" }), /wrong_participant/);
	await assert.rejects(h.message(h.responder, "answer-unknown", { operation: "answer", requestId: "a".repeat(43), answer: "Invalid" }), /unknown_identity/);
	h.responder.blocked = false;
	h.responder.settle();
	await flush();
	await h.message(h.requester, "cancel-delivered", { operation: "cancel", requestMessageId: request.requestMessageId, reason: "Withdraw" });
	h.responder.settle();
	await flush();
	assert.ok(h.deliveries(h.responder).some(d => d.projection.kind === "request_cancellation"));
	await assert.rejects(h.message(h.responder, "answer-cancelled", { operation: "answer", requestId: request.requestMessageId, answer: "Invalid" }), /was cancelled/);
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
		wait(id: string, input: import("../src/protocol/agent-wait.ts").AgentWaitInput = {}) {
			call(requester, id, "agent_wait", input);
			const result = waits.wait("requester", id, input, abort.signal);
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
