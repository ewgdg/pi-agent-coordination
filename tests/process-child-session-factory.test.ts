import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import {
	initTheme,
	type AgentSessionRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

import { WorkflowCoordinator } from "../src/coordination/workflow-coordinator.ts";
import type { AgentRecord } from "../src/coordination/agent-record.ts";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import {
	commitAgentRuntimeBlueprint,
	resolveCommittedAgentRuntimeBlueprint,
} from "../src/protocol/agent-runtime-blueprint.ts";
import { commitChildAgentIdentity } from "../src/protocol/child-identity.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import { ProcessChildSessionFactory } from "../src/runtime/process-child-session-factory.ts";
import {
	bindTestOwnerHost,
	createUnboundTestOwnerHost,
} from "./support/pi-host.ts";
import { createProcessModelBroker } from "./support/process-model-broker.ts";

const TEST_TIMEOUT_MS = 45_000;
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

test("nested spawn snapshots the admitted parent Runtime and only binds skill sources from its blueprint", async () => {
	const root = await mkdirTestRoot("nested-parent-snapshot");
	const parentAgentId = "nested-parent-agent";
	const session = SessionManager.create(root, join(root, "sessions"), {
		id: parentAgentId,
	});
	commitChildAgentIdentity(session, {
		agentId: parentAgentId,
		workflowId: "nested-parent-workflow",
		directSpawnerAgentId: "owner-agent",
		spawnSource: {
			agentId: "owner-agent",
			entryId: "parent-spawn-entry",
			toolCallId: "parent-spawn-tool",
		},
		configuration: {
			label: "Nested Parent",
			baseline: runtimeBaseline(root),
		},
	});
	commitAgentRuntimeBlueprint(session, {
		agentId: parentAgentId,
		role: "ordinary",
		configuration: {
			cwd: join(root, "blueprint-cwd"),
			model: { provider: "blueprint-provider", modelId: "blueprint-model" },
			thinking: "off",
			tools: ["blueprint_tool"],
			skills: ["shared-skill"],
			extensions: [join(root, "blueprint-extension.ts")],
		},
		projectTrusted: false,
		skillSources: [{
			name: "shared-skill",
			path: join(root, "skills", "shared-skill", "SKILL.md"),
		}],
		agentsFiles: [],
	});
	const runtimeCwd = join(root, "runtime-cwd");
	const runtimeExtension = join(root, "runtime-extension.ts");
	const factory = processFactoryForSnapshot();
	const parent = {
		identity: {
			agentId: parentAgentId,
		},
		host: {
			effectiveRuntimeSnapshot: () => ({
				cwd: runtimeCwd,
				model: { provider: "runtime-provider", modelId: "runtime-model" },
				thinking: "high",
				tools: ["runtime_tool"],
				skills: ["shared-skill"],
				fileExtensionPaths: [runtimeExtension],
				projectTrusted: true,
				sessionId: parentAgentId,
			}),
		},
		transcript: transcriptFromSessionManager(session),
	} as unknown as AgentRecord;

	assert.deepEqual(factory.snapshotParentRuntime(parent), {
		baseline: {
			cwd: runtimeCwd,
			model: { provider: "runtime-provider", modelId: "runtime-model" },
			thinking: "high",
			tools: ["runtime_tool"],
			skills: ["shared-skill"],
			extensions: [runtimeExtension],
		},
		projectTrusted: true,
		skillSources: [{
			name: "shared-skill",
			filePath: join(root, "skills", "shared-skill", "SKILL.md"),
		}],
	});
});

test("nested spawn rejects parent skill names that do not align with committed sources", async () => {
	const root = await mkdirTestRoot("nested-parent-skill-mismatch");
	const parentAgentId = "mismatched-parent-agent";
	const session = SessionManager.create(root, join(root, "sessions"), {
		id: parentAgentId,
	});
	commitChildAgentIdentity(session, {
		agentId: parentAgentId,
		workflowId: "mismatched-parent-workflow",
		directSpawnerAgentId: "owner-agent",
		spawnSource: {
			agentId: "owner-agent",
			entryId: "mismatched-spawn-entry",
			toolCallId: "mismatched-spawn-tool",
		},
		configuration: { label: "Mismatched Parent", baseline: runtimeBaseline(root) },
	});
	commitAgentRuntimeBlueprint(session, {
		agentId: parentAgentId,
		role: "ordinary",
		configuration: {
			cwd: root,
			model: { provider: "provider", modelId: "model" },
			thinking: "off",
			tools: [],
			skills: ["committed-skill"],
			extensions: [],
		},
		projectTrusted: true,
		skillSources: [{
			name: "committed-skill",
			path: join(root, "skills", "committed-skill", "SKILL.md"),
		}],
		agentsFiles: [],
	});
	const parent = {
		identity: { agentId: parentAgentId },
		host: {
			effectiveRuntimeSnapshot: () => ({
				cwd: root,
				model: { provider: "provider", modelId: "model" },
				thinking: "off",
				tools: [],
				skills: ["uncommitted-skill"],
				fileExtensionPaths: [],
				projectTrusted: true,
				sessionId: parentAgentId,
			}),
		},
		transcript: transcriptFromSessionManager(session),
	} as unknown as AgentRecord;

	assert.throws(
		() => processFactoryForSnapshot().snapshotParentRuntime(parent),
		/Parent Runtime skills do not align with committed blueprint sources/,
	);
});

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
		processVisibleModel: false,
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
	const host = await createUnboundTestOwnerHost(() => undefined, {
		persistent: true,
		processVisibleModel: false,
	});
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
	initTheme("dark");
	const ownerTheme = (globalThis as Record<PropertyKey, unknown>)[THEME_KEY];
	const moderatorWidgetExtension = join(
		broker.runtimeDirectory,
		"moderator-process-widget.mjs",
	);
	await writeFile(moderatorWidgetExtension, [
		"export default function moderatorProcessWidget(pi) {",
		"  pi.on('session_start', (_event, ctx) => {",
		"    if (process.env.PI_AGENT_COORDINATION_BOOTSTRAP) ctx.ui.setTheme('light');",
		"    ctx.ui.setWidget('moderator-process-widget', [",
		"      'PROCESS_RUNTIME_CHILD_WIDGET',",
		"      `PID=${process.pid}`,",
		"    ]);",
		"  });",
		"}",
	].join("\n"), { mode: 0o600 });
	const host = await createUnboundTestOwnerHost(() => undefined, {
		persistent: true,
		processVisibleModel: false,
		additionalExtensionPaths: [broker.extensionPath, moderatorWidgetExtension],
	});
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(
		host.runtime,
		"<inline:pi-agent-coordination>",
	);
	let moderatorProviderRequests = 0;
	broker.setResponses(Array.from({ length: 6 }, () => (context) => {
		if (context.tools?.some(({ name }) => name === "moderator_control")) {
			moderatorProviderRequests += 1;
			if (moderatorProviderRequests === 1) {
				return fauxAssistantMessage("First committed Moderator attempt fails.", {
					stopReason: "error",
					errorMessage: "deterministic committed Moderator process failure",
				});
			}
			if (moderatorProviderRequests === 2) {
				return fauxAssistantMessage(
					fauxToolCall("moderator_control", {
						operation: "resolve",
						summary: "The replacement inspected the exact failed process Run.",
						rationale: "Exercise the Moderator child-to-Owner process proxy.",
					}, { id: "proxied-moderator-control" }),
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage("Linked replacement Moderator process settled.");
		}
		return fauxAssistantMessage("Answer-obligated ordinary process fails.", {
			stopReason: "error",
			errorMessage: "deterministic ordinary process failure",
		});
	}));
	const coordinator = new WorkflowCoordinator(host.runtime, identity, {
		entryModulePath: "<inline:pi-agent-coordination>",
	});
	let replacementPid: number | undefined;
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
			moderatorProviderRequests === 3
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
			assert.deepEqual(blueprint.configuration.tools, [
				"agent_message",
				"agent_control",
				"agent_observe",
				"ask_user_question",
				"moderator_control",
			]);
			assert.deepEqual(blueprint.configuration.extensions, [
				broker.extensionPath,
				moderatorWidgetExtension,
			]);
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
		const replacementTranscriptPath = replacement.status.primaryEvidence.transcriptPath;
		assert.ok(replacementTranscriptPath);
		await waitFor(() => {
			const entries = SessionManager.open(replacementTranscriptPath).getEntries();
			return entries.some(
				(entry) => entry.type === "message" && entry.message.role === "toolResult" &&
					entry.message.toolCallId === "proxied-moderator-control",
			);
		});
		const moderatorControlResult = SessionManager.open(replacementTranscriptPath)
			.getEntries()
			.find(
				(entry) => entry.type === "message" && entry.message.role === "toolResult" &&
					entry.message.toolCallId === "proxied-moderator-control",
			);
		assert.ok(
			moderatorControlResult?.type === "message" &&
			moderatorControlResult.message.role === "toolResult",
		);
		assert.equal(
			(moderatorControlResult.message.details as { disposition: string }).disposition,
			"blocked",
		);
		await waitFor(() => {
			const run = owner.status(replacement.status.agentId).run;
			return run.phase === "live" && run.work === "settled";
		});

		const view = await owner.openAgentView(replacement.status.agentId);
		assert.ok(view);
		await waitFor(() => view.projection().presentation.render(80)
			.map(stripTerminalSequences)
			.join("\n")
			.includes("PROCESS_RUNTIME_CHILD_WIDGET"));
		const frame = view.projection().presentation.render(80)
			.map(stripTerminalSequences)
			.join("\n");
		const pidMatch = frame.match(/PID=(\d+)/);
		assert.ok(pidMatch);
		replacementPid = Number(pidMatch[1]);
		assert.ok(Number.isSafeInteger(replacementPid) && replacementPid > 1);
		assert.notEqual(replacementPid, process.pid);
		assert.equal(
			(globalThis as Record<PropertyKey, unknown>)[THEME_KEY],
			ownerTheme,
			"child-local theme changes must not mutate Owner process globals",
		);
		await view.close();
		assert.equal(moderatorProviderRequests, 3);
	} finally {
		await coordinator.shutdown(async () => host.runtime.dispose());
		await broker.close();
	}
	assert.ok(replacementPid);
	assert.throws(() => process.kill(replacementPid, 0), hasCode("ESRCH"));
	await waitFor(async () => (await runtimeArtifacts(identity.workflowId)).length === 0);
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

function hasCode(code: string): (error: unknown) => boolean {
	return (error) => typeof error === "object" && error !== null && "code" in error &&
		(error as NodeJS.ErrnoException).code === code;
}

function processFactoryForSnapshot(): ProcessChildSessionFactory {
	return new ProcessChildSessionFactory({
		ownerRuntime: {} as AgentSessionRuntime,
		ownerIdentity: {
			agentId: "owner-agent",
			workflowId: "snapshot-workflow",
			directSpawnerAgentId: null,
			configuration: { label: "owner", baseline: runtimeBaseline(tmpdir()) },
		},
		entryModulePath: join(tmpdir(), "package", "src", "index.ts"),
		packageRoot: join(tmpdir(), "package"),
		ownerRequestHandlers() {
			throw new Error("Snapshot test does not launch a Runtime");
		},
	});
}

function runtimeBaseline(cwd: string) {
	return {
		cwd,
		model: { provider: "baseline-provider", modelId: "baseline-model" },
		thinking: "off" as const,
		tools: [],
		skills: [],
		extensions: [],
	};
}

function mkdirTestRoot(name: string): Promise<string> {
	return mkdtemp(join(tmpdir(), `pi-process-factory-${name}-`));
}
