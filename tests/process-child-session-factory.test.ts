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
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

import type { AgentRecord } from "../src/coordination/agent-record.ts";
import { WorkflowCoordinator } from "../src/coordination/workflow-coordinator.ts";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import { AgentRuntimeSupervisor } from "../src/runtime/agent-runtime-supervisor.ts";
import { ProcessChildSessionFactory } from "../src/runtime/process-child-session-factory.ts";
import {
	bindTestOwnerHost,
	createUnboundTestOwnerHost,
} from "./support/pi-host.ts";
import { createProcessModelBroker } from "./support/process-model-broker.ts";

const TEST_TIMEOUT_MS = 45_000;
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

test("a dormant parent is dynamically re-resolved before each descendant Runtime preparation", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dynamic-parent-runtime-"));
	const templateRoot = join(root, "templates");
	await mkdir(templateRoot);
	const templatePath = join(templateRoot, "parent.md");
	await writeFile(
		templatePath,
		"---\nname: dynamic-parent\ntools:\n  - read\n  - bash\n---\n",
	);
	const host = await createUnboundTestOwnerHost(() => undefined, {
		persistent: true,
		processVisibleModel: true,
	});
	await bindTestOwnerHost(host, "tui");
	const ownerIdentity = adoptOrValidateOwnerIdentity(host.runtime);
	const ownerRecord: AgentRecord = {
		identity: ownerIdentity,
		host: AgentRuntimeSupervisor.bindOwner(host.runtime),
		transcript: transcriptFromSessionManager(host.session.sessionManager),
		children: ["dormant-parent"],
	};
	const parentSession = SessionManager.inMemory(host.cwd, { id: "dormant-parent" });
	parentSession.appendCustomEntry("agent-coordination.identity", { marker: true });
	const parentRecord = {
		identity: {
			agentId: "dormant-parent",
			workflowId: ownerIdentity.workflowId,
			directSpawnerAgentId: ownerIdentity.agentId,
			spawnSource: {
				agentId: ownerIdentity.agentId,
				entryId: "parent-spawn-entry",
				toolCallId: "parent-spawn-call",
			},
			metadata: { label: "dynamic-parent" },
		},
		creationInput: {
			request: "Act as the dynamically configured parent.",
			template: "dynamic-parent",
		},
		host: {
			effectiveRuntimeSnapshot: () => undefined,
		} as unknown as AgentRecord["host"],
		transcript: transcriptFromSessionManager(parentSession),
		children: [],
	} satisfies AgentRecord;
	const agents = new Map([
		[ownerIdentity.agentId, ownerRecord],
		[parentRecord.identity.agentId, parentRecord],
	]);
	const factory = new ProcessChildSessionFactory({
		ownerRuntime: host.runtime,
		ownerIdentity,
		entryModulePath: "<inline:pi-agent-coordination>",
		packageRoot: root,
		templateRoots: () => [{ scope: "test", path: templateRoot }],
		resolveAgent: (agentId) => agents.get(agentId),
		ownerRequestHandlers() {
			throw new Error("Preparation test must not launch a child process");
		},
	});
	try {
		const first = await factory.prepareOrdinaryRun({
			agentId: "descendant",
			parent: parentRecord,
			spawnInput: { request: "Inherit the current parent configuration." },
		});
		assert.equal(first.configuration.tools.includes("read"), true);
		assert.equal(first.configuration.tools.includes("bash"), true);

		await writeFile(
			templatePath,
			"---\nname: dynamic-parent\ntools: read\n---\n",
		);
		const second = await factory.prepareOrdinaryRun({
			agentId: "descendant",
			parent: parentRecord,
			spawnInput: { request: "Inherit the current parent configuration." },
		});
		assert.equal(second.configuration.tools.includes("read"), true);
		assert.equal(second.configuration.tools.includes("bash"), false);
	} finally {
		await host.runtime.dispose();
	}
});

test("a live parent contributes its current synchronized Runtime state", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-live-parent-runtime-"));
	const host = await createUnboundTestOwnerHost(() => undefined, {
		persistent: true,
		processVisibleModel: true,
	});
	await bindTestOwnerHost(host, "tui");
	const ownerIdentity = adoptOrValidateOwnerIdentity(host.runtime);
	const ownerRecord: AgentRecord = {
		identity: ownerIdentity,
		host: AgentRuntimeSupervisor.bindOwner(host.runtime),
		transcript: transcriptFromSessionManager(host.session.sessionManager),
		children: ["live-parent"],
	};
	const parentSession = SessionManager.inMemory(host.cwd, { id: "live-parent" });
	parentSession.appendCustomEntry("agent-coordination.identity", { marker: true });
	const model = host.session.model;
	assert.ok(model);
	const synchronizedSnapshot = {
		cwd: host.cwd,
		model: { provider: model.provider, modelId: model.id },
		thinking: host.session.thinkingLevel,
		tools: ["bash"],
		skills: [],
		skillSources: [],
		fileExtensionPaths: [],
		projectTrusted: true,
		sessionId: "live-parent",
	} as const;
	let synchronizations = 0;
	const parentRecord = {
		identity: {
			agentId: "live-parent",
			workflowId: ownerIdentity.workflowId,
			directSpawnerAgentId: ownerIdentity.agentId,
			spawnSource: {
				agentId: ownerIdentity.agentId,
				entryId: "live-parent-spawn-entry",
				toolCallId: "live-parent-spawn-call",
			},
			metadata: { label: "live-parent" },
		},
		creationInput: { request: "Act as the live parent." },
		host: {
			effectiveRuntimeSnapshot: () => ({ ...synchronizedSnapshot, tools: ["read"] }),
			async synchronizeRuntimeState() {
				synchronizations += 1;
				return synchronizedSnapshot;
			},
		} as unknown as AgentRecord["host"],
		transcript: transcriptFromSessionManager(parentSession),
		children: [],
	} satisfies AgentRecord;
	const agents = new Map([
		[ownerIdentity.agentId, ownerRecord],
		[parentRecord.identity.agentId, parentRecord],
	]);
	const factory = new ProcessChildSessionFactory({
		ownerRuntime: host.runtime,
		ownerIdentity,
		entryModulePath: "<inline:pi-agent-coordination>",
		packageRoot: root,
		templateRoots: () => [],
		resolveAgent: (agentId) => agents.get(agentId),
		ownerRequestHandlers() {
			throw new Error("Preparation test must not launch a child process");
		},
	});
	try {
		const prepared = await factory.prepareOrdinaryRun({
			agentId: "live-descendant",
			parent: parentRecord,
			spawnInput: { request: "Inherit current live state." },
		});
		assert.equal(synchronizations, 1);
		assert.equal(prepared.configuration.tools.includes("bash"), true);
		assert.equal(prepared.configuration.tools.includes("read"), false);
	} finally {
		await host.runtime.dispose();
	}
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
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
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
		assert.deepEqual(
			initialEntries.flatMap((entry) => entry.type === "custom" ? [entry.customType] : []),
			["agent-coordination.identity"],
		);

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
			fauxAssistantMessage("Dynamically prepared successor used the same transcript."),
		]);
		const successorInput = {
			operation: "send" as const,
			targetAgentId: receipt.agentId,
			content: "Start one successor after re-resolving current resources.",
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
						(part) => part.type === "text" && part.text.includes("Dynamically prepared successor"),
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
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
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
		assert.deepEqual(
			durable.getEntries().flatMap(
				(entry) => entry.type === "custom" ? [entry.customType] : [],
			),
			["agent-coordination.identity"],
		);
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
	await mkdir(host.services.agentDir, { recursive: true });
	const childSettingsPath = join(host.services.agentDir, "settings.json");
	await writeFile(childSettingsPath, `${JSON.stringify({ theme: "dark" })}\n`);
	await bindTestOwnerHost(host, "tui");
	const identity = adoptOrValidateOwnerIdentity(host.runtime);
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
			assert.equal(
				entries.some((entry) => entry.type === "custom"),
				false,
			);
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
		assert.equal(
			(JSON.parse(await readFile(childSettingsPath, "utf8")) as { theme?: string }).theme,
			"light",
			"child Pi settings must use the same Agent directory as its Owner Runtime",
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
