import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { WorkflowExecutionScheduler } from "../src/coordination/workflow-execution-scheduler.ts";
import { WorkflowCoordinator } from "../src/coordination/workflow-coordinator.ts";
import { createAgentBoundExtension } from "../src/bootstrap/agent-extension.ts";
import type {
	HumanRequestPresentation,
	PresentedHumanRequest,
} from "../src/coordination/human-requests.ts";
import {
	WorkflowPolicyStore,
	parseWorkflowPolicy,
} from "../src/policy/workflow-policy.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import {
	bindTestOwnerHost,
	createUnboundTestOwnerHost,
} from "./support/pi-host.ts";

test("ordinary executions enter and leave one Workflow-wide FIFO capacity", async () => {
	const policy = new WorkflowPolicyStore(
		parseWorkflowPolicy('{"maxConcurrentAgentRuns": 2}'),
	);
	const scheduler = new WorkflowExecutionScheduler(policy);
	const admitted: string[] = [];
	const first = scheduler.admit("ordinary").then((permit) => {
		admitted.push("first");
		return permit;
	});
	const second = scheduler.admit("ordinary").then((permit) => {
		admitted.push("second");
		return permit;
	});
	const third = scheduler.admit("ordinary").then((permit) => {
		admitted.push("third");
		return permit;
	});
	const fourth = scheduler.admit("ordinary").then((permit) => {
		admitted.push("fourth");
		return permit;
	});
	const [firstPermit, secondPermit] = await Promise.all([first, second]);
	await Promise.resolve();
	assert.deepEqual(admitted, ["first", "second"]);

	secondPermit?.release();
	const thirdPermit = await third;
	assert.deepEqual(admitted, ["first", "second", "third"]);
	firstPermit?.release();
	const fourthPermit = await fourth;
	assert.deepEqual(admitted, ["first", "second", "third", "fourth"]);

	thirdPermit?.release();
	fourthPermit?.release();
});

test("queued executions keep captured limits across prospective policy reload", async () => {
	const initial = parseWorkflowPolicy('{"maxConcurrentAgentRuns": 2}');
	const policy = new WorkflowPolicyStore(initial);
	const scheduler = new WorkflowExecutionScheduler(policy);
	const first = await scheduler.admit("ordinary");
	const second = await scheduler.admit("ordinary");

	const reduced = parseWorkflowPolicy('{"maxConcurrentAgentRuns": 1}');
	policy.publish(reduced);
	let reducedAdmitted = false;
	const underReducedLimit = scheduler.admit("ordinary").then((permit) => {
		reducedAdmitted = true;
		return permit;
	});
	const raised = parseWorkflowPolicy('{"maxConcurrentAgentRuns": 3}');
	policy.publish(raised);
	let raisedAdmitted = false;
	const afterRaise = scheduler.admit("ordinary").then((permit) => {
		raisedAdmitted = true;
		return permit;
	});

	first?.release();
	await Promise.resolve();
	assert.equal(reducedAdmitted, false);
	assert.equal(raisedAdmitted, false);
	second?.release();
	const reducedPermit = await underReducedLimit;
	const raisedPermit = await afterRaise;
	assert.equal(reducedAdmitted, true);
	assert.equal(raisedAdmitted, true);

	reducedPermit?.release();
	raisedPermit?.release();
});

test("an aborted queued execution leaves FIFO without consuming capacity", async () => {
	const policy = new WorkflowPolicyStore(
		parseWorkflowPolicy('{"maxConcurrentAgentRuns": 1}'),
	);
	const scheduler = new WorkflowExecutionScheduler(policy);
	const active = await scheduler.admit("ordinary");
	const aborted = new AbortController();
	const removed = scheduler.admit("ordinary", aborted.signal);
	let followingAdmitted = false;
	const following = scheduler.admit("ordinary").then((permit) => {
		followingAdmitted = true;
		return permit;
	});

	aborted.abort();
	assert.equal(await removed, undefined);
	assert.equal(followingAdmitted, false);
	active?.release();
	const followingPermit = await following;
	assert.equal(followingAdmitted, true);
	followingPermit?.release();
});

test("Moderator execution is exempt and does not release an ordinary waiter", async () => {
	const policy = new WorkflowPolicyStore(
		parseWorkflowPolicy('{"maxConcurrentAgentRuns": 1}'),
	);
	const scheduler = new WorkflowExecutionScheduler(policy);
	const active = await scheduler.admit("ordinary");
	let waitingAdmitted = false;
	const waiting = scheduler.admit("ordinary").then((permit) => {
		waitingAdmitted = true;
		return permit;
	});

	const moderator = await scheduler.admit("moderator");
	assert.ok(moderator);
	moderator?.release();
	await Promise.resolve();
	assert.equal(waitingAdmitted, false);

	active?.release();
	const waitingPermit = await waiting;
	assert.equal(waitingAdmitted, true);
	waitingPermit?.release();
});

test("real ordinary child Runs share fair execution capacity before generation and tools", async (t) => {
	const registryKey = Symbol.for("pi-agent-coordination.test.execution-gate");
	let firstToolStarted!: () => void;
	const firstToolStart = new Promise<void>((resolve) => {
		firstToolStarted = resolve;
	});
	let releaseFirstTool!: () => void;
	const firstToolRelease = new Promise<void>((resolve) => {
		releaseFirstTool = resolve;
	});
	let secondToolStarted!: () => void;
	const secondToolStart = new Promise<void>((resolve) => {
		secondToolStarted = resolve;
	});
	let toolExecutions = 0;
	(globalThis as Record<PropertyKey, unknown>)[registryKey] = {
		async execute() {
			toolExecutions += 1;
			if (toolExecutions === 1) {
				firstToolStarted();
				await firstToolRelease;
				return;
			}
			secondToolStarted();
		},
	};
	t.after(() => {
		delete (globalThis as Record<PropertyKey, unknown>)[registryKey];
	});

	const host = await createUnboundTestOwnerHost(() => undefined, {
		persistent: true,
		additionalExtensionPaths: [
			fileURLToPath(new URL("./support/execution-gate-tool.ts", import.meta.url)),
		],
	});
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(
		host.runtime,
		"<inline:pi-agent-coordination>",
	);
	const policy = new WorkflowPolicyStore(
		parseWorkflowPolicy('{"maxConcurrentAgentRuns": 1}'),
	);
	const childSessions: AgentSession[] = [];
	let coordinator: WorkflowCoordinator;
	coordinator = new WorkflowCoordinator(host.runtime, identity, {
		entryModulePath: "<inline:pi-agent-coordination>",
		workflowPolicy: policy,
		childExtensionFactory: (agentId) =>
			createAgentBoundExtension(() => coordinator.forAgent(agentId)),
		spawnBoundaryHooks: {
			afterRunStart({ session }) {
				childSessions.push(session);
			},
		},
	});
	const owner = coordinator.forAgent(identity.agentId);
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall("execution_gate", {}, { id: "first-execution-gate" }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("First execution completed."),
		fauxAssistantMessage(
			fauxToolCall("execution_gate", {}, { id: "second-execution-gate" }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Second execution completed."),
	]);

	await spawnChild(owner, host, "first-capacity-child");
	await firstToolStart;
	await spawnChild(owner, host, "second-capacity-child");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(toolExecutions, 1);

	releaseFirstTool();
	await secondToolStart;
	assert.equal(toolExecutions, 2);
	await Promise.all(childSessions.map((session) => session.waitForIdle()));
	const policyDirectory = join(host.services.agentDir, "config");
	await mkdir(policyDirectory, { recursive: true });
	await writeFile(
		join(policyDirectory, "pi-agent-coordination.json"),
		'{"maxConcurrentAgentRuns": 7}',
		"utf8",
	);
	const childTranscript = structuredClone(childSessions[0]!.sessionManager.getEntries());
	await childSessions[0]!.reload();
	assert.equal(policy.current().maxConcurrentAgentRuns, 1);
	assert.deepEqual(childSessions[0]!.sessionManager.getEntries(), childTranscript);

	await host.runtime.dispose();
});

test("an input-required ordinary Run releases capacity until work can resume", async (t) => {
	const registryKey = Symbol.for("pi-agent-coordination.test.execution-gate");
	let secondToolStarted!: () => void;
	const secondToolStart = new Promise<void>((resolve) => {
		secondToolStarted = resolve;
	});
	let releaseSecondTool!: () => void;
	const secondToolRelease = new Promise<void>((resolve) => {
		releaseSecondTool = resolve;
	});
	(globalThis as Record<PropertyKey, unknown>)[registryKey] = {
		async execute() {
			secondToolStarted();
			await secondToolRelease;
		},
	};
	t.after(() => {
		delete (globalThis as Record<PropertyKey, unknown>)[registryKey];
	});
	let presentedRequest!: (request: PresentedHumanRequest) => void;
	const requestPresented = new Promise<PresentedHumanRequest>((resolve) => {
		presentedRequest = resolve;
	});
	const presented = new Map<string, PresentedHumanRequest>();
	const presentation: HumanRequestPresentation = {
		present(request) {
			presented.set(request.requestId, request);
			presentedRequest(request);
		},
		dismiss(requestId) {
			presented.delete(requestId);
		},
		items: () => [...presented.values()],
		async focus() {},
	};
	const host = await createUnboundTestOwnerHost(() => undefined, {
		persistent: true,
		additionalExtensionPaths: [
			fileURLToPath(new URL("./support/execution-gate-tool.ts", import.meta.url)),
		],
	});
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(
		host.runtime,
		"<inline:pi-agent-coordination>",
	);
	const policy = new WorkflowPolicyStore(
		parseWorkflowPolicy('{"maxConcurrentAgentRuns": 1}'),
	);
	const childSessions: AgentSession[] = [];
	let coordinator: WorkflowCoordinator;
	coordinator = new WorkflowCoordinator(host.runtime, identity, {
		entryModulePath: "<inline:pi-agent-coordination>",
		workflowPolicy: policy,
		humanRequestPresentation: presentation,
		childExtensionFactory: (agentId) =>
			createAgentBoundExtension(() => coordinator.forAgent(agentId)),
		spawnBoundaryHooks: {
			afterRunStart({ session }) {
				childSessions.push(session);
			},
		},
	});
	const owner = coordinator.forAgent(identity.agentId);
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"ask_user_question",
				{
					questions: [
						{
							kind: "select_one",
							header: "Continue",
							prompt: "May this Run resume after the other child finishes?",
							options: [{ label: "Yes" }],
							allowOther: false,
						},
					],
				},
				{ id: "input-required-capacity" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(
			fauxToolCall("execution_gate", {}, { id: "execution-after-human-wait" }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The second child completed first."),
		fauxAssistantMessage("The Human Answer resumed the first child."),
	]);

	await spawnChild(owner, host, "input-required-child");
	const humanRequest = await requestPresented;
	await spawnChild(owner, host, "execution-while-input-required");
	await secondToolStart;
	assert.equal(
		humanRequest.submit([{ kind: "select_one", selectedOptionIndex: 0 }]),
		true,
	);
	releaseSecondTool();
	await Promise.all(childSessions.map((session) => session.waitForIdle()));

	await host.runtime.dispose();
});

async function spawnChild(
	owner: ReturnType<WorkflowCoordinator["forAgent"]>,
	host: Awaited<ReturnType<typeof createUnboundTestOwnerHost>>,
	toolCallId: string,
): Promise<void> {
	const input = { request: `Creation Request for ${toolCallId}` } as const;
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_spawn", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const receipt = await owner.spawn(toolCallId, input);
	assert.equal(receipt.disposition, "pending");
}
