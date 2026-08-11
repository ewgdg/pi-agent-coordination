import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { WorkflowCoordinator } from "../src/coordination/workflow-coordinator.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { resolveCommittedAgentRuntimeBlueprint } from "../src/protocol/agent-runtime-blueprint.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import {
	bindTestOwnerHost,
	createUnboundTestOwnerHost,
} from "./support/pi-host.ts";
import { createProcessModelBroker } from "./support/process-model-broker.ts";

const TEST_TIMEOUT_MS = 45_000;

test("ordinary production spawn runs in a real child process over Owner participant RPC", {
	timeout: TEST_TIMEOUT_MS,
	skip: process.platform === "win32",
}, async () => {
	const broker = await createProcessModelBroker({
		providerId: "process-child-cutover-test",
		modelId: "process-child-cutover-model",
	});
	const host = await createUnboundTestOwnerHost(() => undefined, {
		persistent: true,
		additionalExtensionPaths: [broker.extensionPath],
	});
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(
		host.runtime,
		"<inline:pi-agent-coordination>",
	);
	const effectiveCwd = join(host.cwd, "process-child-cwd");
	await mkdir(effectiveCwd);
	const pidEvidence = join(effectiveCwd, "child-pid.txt");
	let creationRequestId = "";
	broker.setResponses([
		fauxAssistantMessage(
			fauxToolCall("bash", { command: `printf '%s' "$PPID" > ${JSON.stringify(pidEvidence)}` }, {
				id: "real-child-bash",
			}),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(
			fauxToolCall("agent_observe", { operation: "status" }, {
				id: "proxied-child-observe",
			}),
			{ stopReason: "toolUse" },
		),
		() => fauxAssistantMessage(
			fauxToolCall("agent_message", {
				operation: "answer",
				requestId: creationRequestId,
				answer: "Process child answer crossed the Owner RPC boundary.",
			}, { id: "proxied-child-message" }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Real process child completed after proxied observation."),
	]);
	const coordinator = new WorkflowCoordinator(host.runtime, identity, {
		entryModulePath: "<inline:pi-agent-coordination>",
	});
	try {
		const owner = coordinator.forAgent(identity.agentId);
		const input = {
			request: "Prove the process Runtime and inspect your coordinated status.",
			config: {
				cwd: effectiveCwd,
				model: { provider: broker.providerId, modelId: broker.modelId },
				tools: ["bash"],
			},
		};
		const spawnEntryId = host.session.sessionManager.appendMessage(
			fauxAssistantMessage(
				fauxToolCall("agent_spawn", input, { id: "spawn-real-process-child" }),
				{ stopReason: "toolUse" },
			),
		);
		creationRequestId = deriveMessageIdentity({
			agentId: identity.agentId,
			entryId: spawnEntryId,
			toolCallId: "spawn-real-process-child",
		});

		const receipt = await owner.spawn("spawn-real-process-child", input);
		assert.equal(receipt.disposition, "pending");
		assert.ok("agentId" in receipt);
		const child = owner.children()[0];
		assert.equal(child?.agentId, receipt.agentId);
		assert.equal(child?.run.phase, "live");
		const sessionPath = child?.primaryEvidence.transcriptPath;
		assert.ok(sessionPath);

		const initialTranscript = SessionManager.open(sessionPath);
		assert.equal(initialTranscript.getHeader()?.cwd, effectiveCwd);
		const initialEntries = initialTranscript.getEntries();
		assert.equal(initialEntries[0]?.type, "custom");
		const blueprint = resolveCommittedAgentRuntimeBlueprint({
			sessionId: receipt.agentId,
			entries: initialEntries,
		});
		assert.equal(blueprint.configuration.cwd, effectiveCwd);
		assert.deepEqual(blueprint.configuration.extensions, [broker.extensionPath]);

		await waitFor(() => {
			const entries = SessionManager.open(sessionPath).getEntries();
			return entries.some(
				(entry) => entry.type === "message" && entry.message.role === "assistant" &&
					entry.message.content.some(
						(part) => part.type === "text" && part.text.includes("Real process child completed"),
					),
			);
		});
		const childPid = Number(await readFile(pidEvidence, "utf8"));
		assert.ok(Number.isSafeInteger(childPid) && childPid > 1);
		assert.notEqual(childPid, process.pid);
		assert.equal(broker.state.callCount, 4);

		await waitFor(() => owner.status(receipt.agentId).run.phase === "dormant");
		const entriesBeforeSuccessor = SessionManager.open(sessionPath).getEntries().length;
		broker.appendResponses([
			fauxAssistantMessage("Exact committed blueprint successor used the same transcript."),
		]);
		const successorInput = {
			operation: "send" as const,
			targetAgentId: receipt.agentId,
			content: "Start one exact successor without re-resolving resources.",
		};
		host.session.sessionManager.appendMessage(
			fauxAssistantMessage(
				fauxToolCall("agent_message", successorInput, { id: "start-process-successor" }),
				{ stopReason: "toolUse" },
			),
		);
		const successorReceipt = await owner.message(
			"start-process-successor",
			successorInput,
		);
		assert.ok("delivery" in successorReceipt);
		assert.equal(successorReceipt.delivery, "pending");
		await waitFor(() => {
			const entries = SessionManager.open(sessionPath).getEntries();
			return entries.length > entriesBeforeSuccessor && entries.some(
				(entry) => entry.type === "message" && entry.message.role === "assistant" &&
					entry.message.content.some(
						(part) => part.type === "text" && part.text.includes("Exact committed blueprint successor"),
					),
			);
		});
		assert.equal(owner.status(receipt.agentId).primaryEvidence.transcriptPath, sessionPath);
		await waitFor(() => owner.status(receipt.agentId).run.phase === "dormant");
		await waitFor(async () => (await runtimeArtifacts(identity.workflowId)).length === 0);
	} finally {
		await coordinator.shutdown(async () => host.runtime.dispose());
		await broker.close();
	}
});

test("post-Identity process startup failure leaves exact durable evidence and a dormant record", {
	timeout: TEST_TIMEOUT_MS,
	skip: process.platform === "win32",
}, async () => {
	const host = await createUnboundTestOwnerHost(() => undefined, { persistent: true });
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(
		host.runtime,
		"<inline:pi-agent-coordination>",
	);
	const coordinator = new WorkflowCoordinator(host.runtime, identity, {
		entryModulePath: "<inline:pi-agent-coordination>",
	});
	try {
		const owner = coordinator.forAgent(identity.agentId);
		const input = {
			request: "Materialize me before deterministic process startup failure.",
			config: {
				model: { provider: "missing-process-provider", modelId: "missing-process-model" },
				extensions: "none" as const,
			},
		};
		host.session.sessionManager.appendMessage(
			fauxAssistantMessage(
				fauxToolCall("agent_spawn", input, { id: "spawn-post-identity-failure" }),
				{ stopReason: "toolUse" },
			),
		);

		const receipt = await owner.spawn("spawn-post-identity-failure", input);
		assert.equal(receipt.disposition, "created_unscheduled");
		assert.ok("agentId" in receipt);
		assert.equal(receipt.failedStage, "run_start");
		const status = owner.status(receipt.agentId);
		assert.equal(status.run.phase, "dormant");
		assert.ok(status.primaryEvidence.transcriptPath);
		const durable = SessionManager.open(status.primaryEvidence.transcriptPath);
		assert.equal(durable.getSessionId(), receipt.agentId);
		assert.equal(resolveCommittedAgentRuntimeBlueprint({
			sessionId: receipt.agentId,
			entries: durable.getEntries(),
		}).agentId, receipt.agentId);
		await waitFor(async () => (await runtimeArtifacts(identity.workflowId)).length === 0);
	} finally {
		await coordinator.shutdown(async () => host.runtime.dispose());
	}
});

test("Moderator attempts use process Runtimes and one committed failure creates one linked replacement", {
	timeout: TEST_TIMEOUT_MS,
	skip: process.platform === "win32",
}, async () => {
	const broker = await createProcessModelBroker();
	const host = await createUnboundTestOwnerHost(() => undefined, {
		persistent: true,
		additionalExtensionPaths: [broker.extensionPath],
	});
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(
		host.runtime,
		"<inline:pi-agent-coordination>",
	);
	let moderatorProviderRequests = 0;
	broker.setResponses(Array.from({ length: 4 }, () => (context) => {
		if (context.tools?.some(({ name }) => name === "moderator_control")) {
			moderatorProviderRequests += 1;
			return moderatorProviderRequests === 1
				? fauxAssistantMessage("First committed Moderator attempt fails.", {
					stopReason: "error",
					errorMessage: "deterministic committed Moderator process failure",
				})
				: fauxAssistantMessage("Linked replacement Moderator process is live.");
		}
		return fauxAssistantMessage("Answer-obligated ordinary process fails.", {
			stopReason: "error",
			errorMessage: "deterministic ordinary process failure",
		});
	}));
	const coordinator = new WorkflowCoordinator(host.runtime, identity, {
		entryModulePath: "<inline:pi-agent-coordination>",
	});
	try {
		const owner = coordinator.forAgent(identity.agentId);
		const input = {
			request: "Fail this answer-obligated process Run so Moderator retry is required.",
			config: {
				model: { provider: broker.providerId, modelId: broker.modelId },
			},
		};
		host.session.sessionManager.appendMessage(
			fauxAssistantMessage(
				fauxToolCall("agent_spawn", input, { id: "spawn-moderated-process-failure" }),
				{ stopReason: "toolUse" },
			),
		);
		const spawned = await owner.spawn("spawn-moderated-process-failure", input);
		assert.equal(spawned.disposition, "pending");

		await waitFor(() =>
			moderatorStatuses(owner, identity.agentId).length === 2 &&
			moderatorProviderRequests === 2
		);
		const moderators = moderatorStatuses(owner, identity.agentId);
		assert.equal(new Set(moderators.map(({ agentId }) => agentId)).size, 2);
		const attempts = moderators.map((status) => {
			assert.ok(status.primaryEvidence.transcriptPath);
			const transcript = SessionManager.open(status.primaryEvidence.transcriptPath);
			const entries = transcript.getEntries();
			const blueprint = resolveCommittedAgentRuntimeBlueprint({
				sessionId: status.agentId,
				entries,
			});
			assert.equal(blueprint.role, "moderator");
			assert.deepEqual(blueprint.configuration.extensions, [broker.extensionPath]);
			const inputEntry = entries.find(
				(entry) => entry.type === "custom_message" &&
					entry.customType === "agent-coordination.moderator-input",
			);
			assert.ok(inputEntry?.type === "custom_message" && typeof inputEntry.content === "string");
			return {
				status,
				input: JSON.parse(inputEntry.content) as {
					previousAttempt?: { agentId: string; entryId: string };
				},
			};
		});
		const replacement = attempts.find(({ input }) => input.previousAttempt !== undefined);
		assert.ok(replacement?.input.previousAttempt);
		assert.notEqual(replacement.input.previousAttempt.agentId, replacement.status.agentId);
		assert.ok(attempts.some(
			({ status }) => status.agentId === replacement.input.previousAttempt?.agentId,
		));
		assert.equal(moderatorProviderRequests, 2);
	} finally {
		await coordinator.shutdown(async () => host.runtime.dispose());
		await broker.close();
	}
});

async function runtimeArtifacts(workflowId: string): Promise<string[]> {
	const prefix = `pi-ac-${createHash("sha256").update(workflowId).digest("hex").slice(0, 10)}-`;
	return (await readdir(tmpdir())).filter((name) => name.startsWith(prefix));
}

function moderatorStatuses(
	owner: ReturnType<WorkflowCoordinator["forAgent"]>,
	ownerAgentId: string,
) {
	const roster = owner.selectionRoster();
	return [...roster.live, ...roster.dormant].filter(
		(status) => status.directSpawnerAgentId === null && status.agentId !== ownerAgentId,
	);
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + TEST_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for process child evidence");
}
