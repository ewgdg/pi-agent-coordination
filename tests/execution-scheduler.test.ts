import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { WorkflowExecutionScheduler } from "../src/coordination/workflow-execution-scheduler.ts";
import { WorkflowCoordinator } from "../src/coordination/workflow-coordinator.ts";
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
	let firstGenerationStarted!: () => void;
	const firstGenerationStart = new Promise<void>((resolve) => {
		firstGenerationStarted = resolve;
	});
	let releaseFirstGeneration!: () => void;
	const firstGenerationRelease = new Promise<void>((resolve) => {
		releaseFirstGeneration = resolve;
	});
	let secondGenerationStarted!: () => void;
	const secondGenerationStart = new Promise<void>((resolve) => {
		secondGenerationStarted = resolve;
	});
	let generations = 0;

	const host = await createUnboundTestOwnerHost(() => undefined, {
		persistent: true,
	});
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	const policy = new WorkflowPolicyStore(
		parseWorkflowPolicy('{"maxConcurrentAgentRuns": 1}'),
	);
	let coordinator: WorkflowCoordinator;
	coordinator = new WorkflowCoordinator(host.runtime, identity, {
		entryModulePath: "<inline:pi-agent-coordination>",
		workflowPolicy: policy,
	});
	t.after(() => coordinator.shutdown(async () => host.runtime.dispose()));
	const owner = coordinator.forAgent(identity.agentId);
	host.model.setResponses([
		async () => {
			generations += 1;
			firstGenerationStarted();
			await firstGenerationRelease;
			return fauxAssistantMessage("First execution completed.");
		},
		() => {
			generations += 1;
			secondGenerationStarted();
			return fauxAssistantMessage("Second execution completed.");
		},
	]);

	await spawnChild(owner, host, "first-capacity-child");
	await firstGenerationStart;
	await spawnChild(owner, host, "second-capacity-child");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(generations, 1);

	releaseFirstGeneration();
	await secondGenerationStart;
	assert.equal(generations, 2);
	await waitForCondition(() => owner.children().every(
		({ run }) => "work" in run && run.work === "settled",
	));
	const policyDirectory = join(host.services.agentDir, "config");
	await mkdir(policyDirectory, { recursive: true });
	await writeFile(
		join(policyDirectory, "pi-agent-coordination.json"),
		'{"maxConcurrentAgentRuns": 7}',
		"utf8",
	);
	const [firstChild] = owner.children();
	assert.ok(firstChild);
	const childSessionFile = await waitForChildSessionFile(host, firstChild.agentId);
	const childTranscript = structuredClone(SessionManager.open(childSessionFile).getEntries());
	assert.equal(policy.current().maxConcurrentAgentRuns, 1);
	assert.deepEqual(SessionManager.open(childSessionFile).getEntries(), childTranscript);

});

test("an input-required ordinary Run releases capacity until work can resume", async (t) => {
	let secondGenerationStarted!: () => void;
	const secondGenerationStart = new Promise<void>((resolve) => {
		secondGenerationStarted = resolve;
	});
	let releaseSecondGeneration!: () => void;
	const secondGenerationRelease = new Promise<void>((resolve) => {
		releaseSecondGeneration = resolve;
	});
	const host = await createUnboundTestOwnerHost(() => undefined, {
		persistent: true,
	});
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
	const policy = new WorkflowPolicyStore(
		parseWorkflowPolicy('{"maxConcurrentAgentRuns": 1}'),
	);
	let coordinator: WorkflowCoordinator;
	coordinator = new WorkflowCoordinator(host.runtime, identity, {
		entryModulePath: "<inline:pi-agent-coordination>",
		workflowPolicy: policy,
	});
	t.after(() => coordinator.shutdown(async () => host.runtime.dispose()));
	const owner = coordinator.forAgent(identity.agentId);
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"ask_user_question",
				{ question: "May this Run resume after the other child finishes?" },
				{ id: "input-required-capacity" },
			),
			{ stopReason: "toolUse" },
		),
		async () => {
			secondGenerationStarted();
			await secondGenerationRelease;
			return fauxAssistantMessage("The second child completed first.");
		},
		fauxAssistantMessage("The Human Answer resumed the first child."),
	]);

	await spawnChild(owner, host, "input-required-child");
	await waitForCondition(() => owner.humanAttention().length === 1);
	const [waitingChild] = owner.children();
	assert.ok(waitingChild);
	await spawnChild(owner, host, "execution-while-input-required");
	await secondGenerationStart;
	const selected = await owner.openAgentView(waitingChild.agentId);
	assert.ok(selected);
	selected.projection().dispatchInput("Yes\r");
	releaseSecondGeneration();
	await waitForCondition(() => owner.children().every(
		({ run }) => "work" in run && run.work === "settled",
	));
	await selected.close();

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

async function waitForChildSessionFile(
	host: Awaited<ReturnType<typeof createUnboundTestOwnerHost>>,
	childId: string,
): Promise<string> {
	const sessionDirectory = host.session.sessionManager.getSessionDir();
	if (!sessionDirectory) throw new Error("Persistent Owner session directory unavailable");
	const workflowDirectory = join(
		sessionDirectory,
		"pi-agent-coordination",
		Buffer.from(host.session.sessionId, "utf8").toString("base64url"),
	);
	for (let attempt = 0; attempt < 500; attempt += 1) {
		const sessions = await SessionManager.list(host.cwd, workflowDirectory);
		const child = sessions.find(({ id }) => id === childId);
		if (child) return child.path;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Child Pi session file was not created");
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 300; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Expected execution scheduler condition was not reached");
}
