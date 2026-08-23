import assert from "node:assert/strict";
import test from "node:test";

import { MessageDeliveryScheduler } from "../src/coordination/message-delivery-scheduler.ts";
import type { AgentRecord } from "../src/coordination/agent-record.ts";
import { WorkflowPolicyStore } from "../src/policy/workflow-policy.ts";
import type {
	AgentRunHandle,
	AgentRuntimeHost,
} from "../src/runtime/agent-runtime-host.ts";
import { SerialLane } from "../src/runtime/serial-lane.ts";

test("park entry does not await the idle Deferred prompt Promise after Delivery proof commits", async () => {
	const handle: AgentRunHandle = Object.freeze({ sequence: 1 });
	let workState: "active" | "settled" = "settled";
	let proof: { agentId: string; entryId: string } | undefined;
	let resolvePrompt!: () => void;
	const promptCompletion = new Promise<void>((resolve) => {
		resolvePrompt = resolve;
	});
	const lane = new SerialLane();
	const host = {
		lane,
		currentHandle: () => handle,
		isCurrent: (candidate: AgentRunHandle) => candidate === handle,
		addSettledHandler: () => () => undefined,
		addRetentionReason: () => undefined,
		removeRetentionReason: () => undefined,
		blocksOrdinaryDelivery: () => false,
		currentWorkState: () => workState,
		observe: () => ({
			phase: "live" as const,
			work: workState,
			attention: "none" as const,
			retentionReasons: [],
		}),
		deliverInLane: () => ({ completion: promptCompletion }),
	} as unknown as AgentRuntimeHost;
	const record = {
		identity: { agentId: "owner" },
		host,
	} as unknown as AgentRecord;
	const scheduler = new MessageDeliveryScheduler({
		workflowPolicy: new WorkflowPolicyStore(),
	});
	scheduler.integrate(record);
	assert.equal(await scheduler.admitCustom(record, {
		messageId: "idle-deferred-owner-delivery",
		deliveryMode: "deferred",
		customMessage: {
			customType: "owner-idle-delivery",
			content: "This Delivery starts an idle Owner prompt.",
			display: false,
		} as never,
		inspectProof: () => proof,
	}), "pending");

	workState = "active";
	assert.equal(await withTimeout(
		lane.run(() => scheduler.beginParkingInLane(record, handle)),
		100,
	), false);
	proof = { agentId: "owner", entryId: "delivery-proof" };
	assert.equal(await withTimeout(
		lane.run(() => scheduler.beginParkingInLane(record, handle)),
		100,
	), true);

	resolvePrompt();
	scheduler.endParkingInLane(record, handle);
});

async function withTimeout<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error("Park entry awaited native settlement")),
					milliseconds,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
