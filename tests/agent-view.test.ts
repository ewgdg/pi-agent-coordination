import assert from "node:assert/strict";
import test from "node:test";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
	CustomEditor,
	initTheme,
	SessionManager,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
	Text,
	getKeybindings,
	stripTerminalSequences,
	type Component,
} from "@earendil-works/pi-tui";

import piAgentCoordination from "../src/index.ts";
import {
	createAgentBoundExtension,
	createModeratorBoundExtension,
} from "../src/bootstrap/agent-extension.ts";
import { WorkflowCoordinator } from "../src/coordination/workflow-coordinator.ts";
import { createPiNativeProjectionHost } from "../src/pi-integration/native-agent-projection.ts";
import { deriveMessageIdentity } from "../src/protocol/identities.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import { registerAgentsCommand } from "../src/tools/owner-surfaces.ts";
import {
	executeAndCommitRegisteredTool,
	openAgentsSurface,
} from "./support/agent-session.ts";
import {
	bindTestOwnerHost,
	createTestOwnerHost,
	createUnboundTestOwnerHost,
	type TestOwnerHost,
} from "./support/pi-host.ts";

const SURFACE_WAIT_TIMEOUT_MS = 5_000;
const MAX_SELECTOR_NAVIGATION_STEPS = 1_000;

class AgentViewProbeEditor extends CustomEditor {
	readonly #identity: string;
	#escapeCount = 0;

	constructor(
		identity: string,
		...editorArguments: ConstructorParameters<typeof CustomEditor>
	) {
		super(...editorArguments);
		this.#identity = identity;
	}

	override render(width: number): string[] {
		return [
			`Agent editor · ${this.#identity}`,
			`Custom editor Escape count · ${this.#escapeCount}`,
			...super.render(width),
		];
	}

	override handleInput(data: string): void {
		if (data === "\x1b") {
			this.#escapeCount += 1;
			return;
		}
		super.handleInput(data);
	}
}

class ThrowingAgentInputEditor extends CustomEditor {
	override handleInput(data: string): void {
		if (data === "x") throw new Error("deterministic real child editor failure");
		super.handleInput(data);
	}
}

class ThrowingAgentRenderEditor extends CustomEditor {
	#renderFailureArmed = false;

	override handleInput(data: string): void {
		if (data === "x") {
			this.#renderFailureArmed = true;
			return;
		}
		super.handleInput(data);
	}

	override render(width: number): string[] {
		if (this.#renderFailureArmed) {
			throw new Error("deterministic real child render failure");
		}
		return super.render(width);
	}
}

test("/agents presents the live Agent's complete interactive mode while Owner stays bound", async (t) => {
	const host = await createTestOwnerHost(piAgentCoordination, {
		persistent: true,
		additionalExtensionFactories: [{
			name: "interactive-agent-view-probe",
			hidden: true,
			factory: (pi) => {
				pi.on("session_start", (_event, ctx) => {
					const identity = ctx.sessionManager.getSessionId();
					ctx.ui.setEditorComponent((tui, theme, keybindings) =>
						new AgentViewProbeEditor(identity, tui, theme, keybindings)
					);
					ctx.ui.setFooter(() => new Text(`Agent footer · ${identity}`, 0, 0));
					ctx.ui.setStatus("agent-view-probe", `Agent status · ${identity}`);
					ctx.ui.setWidget("agent-view-probe", [`Agent widget · ${identity}`]);
					ctx.ui.notify(`Agent notification · ${identity}`, "info");
				});
				pi.registerCommand("agent-view-probe", {
					description: "Open a child-local presentation probe",
					async handler(_args, ctx) {
						await ctx.ui.custom<void>(
							(_tui, _theme, _keybindings, done) => ({
								render: () => ["Child-local extension overlay"],
								invalidate() {},
								handleInput(data) {
									if (data === "\x1b") done();
								},
							}),
							{ overlay: true },
						);
					},
				});
			},
		}],
	});
	let disposed = false;
	t.after(async () => {
		if (!disposed) await host.runtime.dispose();
	});
	host.model.setResponses([
		fauxAssistantMessage("The child is ready for direct interactive input."),
		fauxAssistantMessage("The child received input through its own editor."),
	]);
	const spawn = await executeAndCommitRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-live-agent-view",
		{
			request: "Remain available for direct input from the Agent view.",
			label: "Viewed Worker",
		},
	);
	const agentId = (spawn.details as { agentId: string }).agentId;
	await waitForCondition(async () =>
		JSON.stringify(await childEntries(host, agentId)).includes(
			"The child is ready for direct interactive input.",
		)
	);

	const ownerRuntimeSession = host.runtime.session;
	const ownerServices = host.runtime.services;
	const ownerDiagnostics = host.runtime.diagnostics;
	const ownerTranscript = host.session.sessionManager.getEntries().map(({ id }) => id);
	const ownerEditorFactory = () => undefined as never;
	host.ui.setEditorComponent(ownerEditorFactory);
	host.ui.setEditorText("unfinished Owner input");
	host.ui.statuses.set("owner-peer-status", "Owner Peer");
	let nativeRebinds = 0;
	host.runtime.setRebindSession(async () => {
		nativeRebinds += 1;
	});

	const { command, view } = await openSelectedAgentView(host, agentId);
	const rendered = stripTerminalSequences(view.render(80).join("\n"));
	assert.match(rendered, /Viewed Worker/);
	assert.match(rendered, new RegExp(agentId.slice(-8)));
	assert.match(rendered, new RegExp(`Agent editor · ${agentId}`));
	assert.match(rendered, new RegExp(`Agent footer · ${agentId}`));
	assert.match(rendered, new RegExp(`Agent widget · ${agentId}`));
	assert.match(rendered, new RegExp(`Agent notification · ${agentId}`));
	assert.match(
		rendered.replace(/\s+/g, ""),
		/Thechildisreadyfordirectinteractiveinput/,
	);
	assert.equal(host.runtime.session, ownerRuntimeSession);
	assert.equal(host.runtime.services, ownerServices);
	assert.equal(host.runtime.diagnostics, ownerDiagnostics);
	assert.deepEqual(
		host.session.sessionManager.getEntries().map(({ id }) => id),
		ownerTranscript,
	);
	assert.equal(host.ui.getEditorComponent(), ownerEditorFactory);
	assert.equal(host.ui.getEditorText(), "unfinished Owner input");
	assert.equal(host.ui.statuses.get("owner-peer-status"), "Owner Peer");
	assert.equal(nativeRebinds, 0);
	assert.equal(await hasRetention(host, agentId, "interactive_selection"), true);

	for (const character of "/agent-view-probe") view.handleInput?.(character);
	view.handleInput?.("\r");
	await waitForCondition(() =>
		stripTerminalSequences(view.render(80).join("\n")).includes(
			"Child-local extension overlay",
		)
	);
	view.handleInput?.("\x1b");
	await waitForCondition(() =>
		!stripTerminalSequences(view.render(80).join("\n")).includes(
			"Child-local extension overlay",
		)
	);
	view.handleInput?.("\x1b");
	assert.match(
		stripTerminalSequences(view.render(80).join("\n")),
		/Custom editor Escape count · 1/,
	);
	assert.equal(host.ui.customSurfaces.includes(view), true);

	for (const character of "Human direction entered in the Agent editor.") {
		view.handleInput?.(character);
	}
	assert.match(
		stripTerminalSequences(view.render(80).join("\n")),
		/Human direction entered in the Agent editor\./,
	);
	view.handleInput?.("\r");
	await waitForCondition(async () =>
		JSON.stringify(await childEntries(host, agentId)).includes(
			"Human direction entered in the Agent editor.",
		)
	);
	await waitForCondition(async () =>
		JSON.stringify(await childEntries(host, agentId)).includes(
			"The child received input through its own editor.",
		)
	);
	assert.equal(host.ui.getEditorText(), "unfinished Owner input");
	assert.equal(host.runtime.session, ownerRuntimeSession);
	assert.equal(host.runtime.services, ownerServices);
	assert.equal(host.runtime.diagnostics, ownerDiagnostics);
	assert.deepEqual(
		host.session.sessionManager.getEntries().map(({ id }) => id),
		ownerTranscript,
	);
	assert.equal(host.ui.getEditorComponent(), ownerEditorFactory);
	assert.equal(host.ui.getEditorText(), "unfinished Owner input");
	assert.equal(host.ui.statuses.get("owner-peer-status"), "Owner Peer");
	assert.equal(nativeRebinds, 0);

	for (const character of "/agents") view.handleInput?.(character);
	view.handleInput?.("\r");
	await waitForCondition(() =>
		stripTerminalSequences(view.render(80).join("\n")).includes("Tab views")
	);
	view.handleInput?.("k");
	const ownerFocusedFrame = stripTerminalSequences(view.render(80).join("\n"));
	assert.match(
		ownerFocusedFrame,
		new RegExp(`→ owner[\\s\\S]*${ownerRuntimeSession.sessionId}`),
	);
	view.handleInput?.("\r");
	await command;
	assert.equal(await hasRetention(host, agentId, "interactive_selection"), false);
	assert.equal(await hasRetention(host, agentId, "answer_owed"), true);
	assert.equal(await currentRunPhase(host, agentId), "live");
	assert.equal(host.runtime.session, ownerRuntimeSession);
	assert.deepEqual(
		host.session.sessionManager.getEntries().map(({ id }) => id),
		ownerTranscript,
	);
	assert.equal(host.ui.getEditorText(), "unfinished Owner input");
	assert.equal(host.ui.getEditorComponent(), ownerEditorFactory);
	assert.equal(nativeRebinds, 0);

	await host.runtime.dispose();
	disposed = true;
});

test("a real child editor failure closes the view and reports one Owner diagnostic", async (t) => {
	const host = await createTestOwnerHost(piAgentCoordination, {
		persistent: true,
		additionalExtensionFactories: [{
			name: "throwing-agent-editor-probe",
			hidden: true,
			factory: (pi) => {
				pi.on("session_start", (_event, ctx) => {
					if (!ctx.sessionManager.getEntries().some((entry) =>
						entry.type === "custom" &&
						entry.customType === "agent-coordination.identity"
					)) return;
					ctx.ui.setEditorComponent((tui, theme, keybindings) =>
						new ThrowingAgentInputEditor(tui, theme, keybindings)
					);
				});
			},
		}],
	});
	t.after(async () => host.runtime.dispose());
	host.model.setResponses([
		fauxAssistantMessage("The throwing-editor Agent is ready."),
	]);
	const spawn = await executeAndCommitRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-throwing-agent-editor",
		{
			request: "Remain available so the Owner can trigger the editor failure.",
			label: "Throwing Editor Worker",
		},
	);
	const agentId = (spawn.details as { agentId: string }).agentId;
	await waitForCondition(async () =>
		JSON.stringify(await childEntries(host, agentId)).includes(
			"The throwing-editor Agent is ready.",
		)
	);
	const ownerSession = host.runtime.session;
	const ownerEditor = "Owner editor survives child input failure";
	host.ui.setEditorText(ownerEditor);
	const { command, view } = await openSelectedAgentView(host, agentId);

	assert.doesNotThrow(() => view.handleInput?.("x"));
	await command;
	assert.equal(host.ui.customSurfaces.length, 0);
	assert.equal(host.runtime.session, ownerSession);
	assert.equal(host.ui.getEditorText(), ownerEditor);
	assert.equal(
		host.services.diagnostics.filter(({ message }) =>
			message.includes("Agent view failed: deterministic real child editor failure")
		).length,
		1,
	);
	await host.session.prompt("Owner remains usable after child editor failure.");
	await host.session.waitForIdle();
});

test("a real child render failure returns a bounded frame and restores Owner input", async (t) => {
	const host = await createTestOwnerHost(piAgentCoordination, {
		persistent: true,
		additionalExtensionFactories: [{
			name: "throwing-agent-render-probe",
			hidden: true,
			factory: (pi) => {
				pi.on("session_start", (_event, ctx) => {
					if (!ctx.sessionManager.getEntries().some((entry) =>
						entry.type === "custom" &&
						entry.customType === "agent-coordination.identity"
					)) return;
					ctx.ui.setEditorComponent((tui, theme, keybindings) =>
						new ThrowingAgentRenderEditor(tui, theme, keybindings)
					);
				});
			},
		}],
	});
	t.after(async () => host.runtime.dispose());
	host.model.setResponses([
		fauxAssistantMessage("The throwing-render Agent is ready."),
	]);
	const spawn = await executeAndCommitRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-throwing-agent-render",
		{
			request: "Remain available so the Owner can trigger the render failure.",
			label: "Throwing Render Worker",
		},
	);
	const agentId = (spawn.details as { agentId: string }).agentId;
	await waitForCondition(async () =>
		JSON.stringify(await childEntries(host, agentId)).includes(
			"The throwing-render Agent is ready.",
		)
	);
	const ownerSession = host.runtime.session;
	const ownerEditor = "Owner editor survives child render failure";
	host.ui.setEditorText(ownerEditor);
	const { command, view } = await openSelectedAgentView(host, agentId);

	view.handleInput?.("x");
	let failedFrame: string[] = [];
	assert.doesNotThrow(() => {
		failedFrame = view.render(80);
	});
	assert.match(failedFrame.join("\n"), /Agent view failed; returning to Owner/);
	await command;
	assert.equal(host.ui.customSurfaces.length, 0);
	assert.equal(host.runtime.session, ownerSession);
	assert.equal(host.ui.getEditorText(), ownerEditor);
	assert.equal(
		host.services.diagnostics.filter(({ message }) =>
			message.includes("Agent view failed: deterministic real child render failure")
		).length,
		1,
	);
});

test("a session_start modal is interactive before Agent Run startup settles", async (t) => {
	const host = await createTestOwnerHost(piAgentCoordination, {
		persistent: true,
		additionalExtensionFactories: [{
			name: "agent-startup-modal-probe",
			hidden: true,
			factory: (pi) => {
				pi.on("session_start", async (_event, ctx) => {
					if (!ctx.sessionManager.getEntries().some((entry) =>
						entry.type === "custom" &&
						entry.customType === "agent-coordination.identity"
					)) return;
					await ctx.ui.confirm(
						"Agent startup gate",
						"Continue exact Run initialization?",
					);
				});
			},
		}],
	});
	t.after(async () => host.runtime.dispose());
	host.model.setResponses([
		fauxAssistantMessage("The startup-modal Agent continued."),
	]);
	const ownerKeybindings = getKeybindings();
	initTheme("dark");
	const ownerTheme = (globalThis as Record<PropertyKey, unknown>)[
		Symbol.for("@earendil-works/pi-coding-agent:theme")
	];
	const spawning = executeAndCommitRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-startup-modal-agent-view",
		{
			request: "Wait for the startup modal, then report readiness.",
			label: "Startup Modal Worker",
		},
	);

	let command!: Promise<void>;
	let selector!: Component;
	const selectorDeadline = Date.now() + SURFACE_WAIT_TIMEOUT_MS;
	while (Date.now() < selectorDeadline) {
		({ command, surface: selector } = await openAgentsSurface(host));
		if (
			stripTerminalSequences(selector.render(80).join("\n")).includes(
				"Startup Modal Worker",
			)
		) break;
		selector.handleInput?.("\x1b");
		await command;
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	const agentId = selectAgentByLabel(selector, "Startup Modal Worker");
	assert.ok(agentId);
	await waitForCondition(() =>
		host.ui.customSurfaces.length === 1 && host.ui.customSurfaces[0] !== selector
	);
	const view = host.ui.customSurfaces[0]!;
	await waitForCondition(() =>
		stripTerminalSequences(view.render(80).join("\n")).includes(
			"Agent startup gate",
		)
	);
	assert.equal(getKeybindings(), ownerKeybindings);
	assert.equal(
		(globalThis as Record<PropertyKey, unknown>)[
			Symbol.for("@earendil-works/pi-coding-agent:theme")
		],
		ownerTheme,
	);
	view.handleInput?.("\r");
	const spawn = await spawning;
	assert.equal((spawn.details as { agentId: string }).agentId, agentId);
	await waitForCondition(async () =>
		JSON.stringify(await childEntries(host, agentId)).includes(
			"The startup-modal Agent continued.",
		)
	);
	await returnAgentViewToOwner(host, view, command);
});

test("a submitted Dormant Agent turn survives returning to the Owner during prompt preflight", async (t) => {
	const submittedInput = "Continue after the Owner leaves this Agent view.";
	let markInputPreflightStarted!: () => void;
	const inputPreflightStarted = new Promise<void>((resolve) => {
		markInputPreflightStarted = resolve;
	});
	let releaseInputPreflight!: () => void;
	const inputPreflightGate = new Promise<void>((resolve) => {
		releaseInputPreflight = resolve;
	});
	let markInputPreflightFinished!: () => void;
	const inputPreflightFinished = new Promise<void>((resolve) => {
		markInputPreflightFinished = resolve;
	});
	let staleContextError: unknown;
	let coordinator!: WorkflowCoordinator;
	const host = await createUnboundTestOwnerHost(() => undefined, {
		persistent: true,
		additionalExtensionFactories: [{
			name: "delayed-child-prompt-preflight",
			hidden: true,
			factory(pi) {
				pi.on("input", async (event, ctx) => {
					if (
						event.text !== submittedInput ||
						!ctx.sessionManager.getEntries().some((entry) =>
							entry.type === "custom" &&
							entry.customType === "agent-coordination.identity"
						)
					) return { action: "continue" };
					markInputPreflightStarted();
					await inputPreflightGate;
					try {
						void ctx.cwd;
					} catch (error) {
						staleContextError = error;
						return { action: "handled" };
					} finally {
						markInputPreflightFinished();
					}
					return { action: "continue" };
				});
			},
		}],
	});
	const identity = adoptOrValidateOwnerIdentity(
		host.runtime,
		"<inline:pi-agent-coordination>",
	);
	coordinator = new WorkflowCoordinator(host.runtime, identity, {
		entryModulePath: "<inline:pi-agent-coordination>",
	});
	await bindTestOwnerHost(host, "tui");
	const owner = coordinator.forAgent(identity.agentId);
	t.after(async () => {
		releaseInputPreflight();
		await coordinator.shutdown(async () => host.runtime.dispose());
	});
	const spawnInput = {
		request: "Settle before the Owner submits a successor turn.",
		label: "Preflight Retention Worker",
	};
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_spawn", spawnInput, {
				id: "spawn-preflight-retention-worker",
			}),
			{ stopReason: "toolUse" },
		),
	);
	const spawnSourceEntry = host.session.sessionManager.getLeafEntry();
	assert.ok(spawnSourceEntry);
	const creationRequestId = deriveMessageIdentity({
		agentId: identity.agentId,
		entryId: spawnSourceEntry.id,
		toolCallId: "spawn-preflight-retention-worker",
	});
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall("agent_message", {
				operation: "answer",
				requestId: creationRequestId,
				answer: "The initial Agent turn settled.",
			}, { id: "answer-preflight-retention-creation-request" }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The initial Agent turn settled."),
		fauxAssistantMessage("The submitted turn completed after returning to the Owner."),
	]);
	const spawn = await owner.spawn("spawn-preflight-retention-worker", spawnInput);
	assert.ok("agentId" in spawn && spawn.agentId);
	const agentId = spawn.agentId;
	await waitForCondition(() => {
		const transcriptPath = owner.status(agentId).primaryEvidence.transcriptPath;
		return transcriptPath !== null && JSON.stringify(
			SessionManager.open(transcriptPath).getEntries(),
		).includes("The initial Agent turn settled.");
	});
	await waitForCondition(() => owner.status(agentId).run.phase === "dormant");

	const activeView = await owner.openAgentView(agentId);
	assert.ok(activeView);
	for (const character of submittedInput) {
		activeView.projection().dispatchInput(character);
	}
	activeView.projection().dispatchInput("\r");
	await inputPreflightStarted;
	await owner.openAgentView(identity.agentId);
	releaseInputPreflight();
	await inputPreflightFinished;

	assert.equal(
		staleContextError,
		undefined,
		staleContextError instanceof Error ? staleContextError.message : String(staleContextError),
	);
	await waitForCondition(() => {
		const transcriptPath = owner.status(agentId).primaryEvidence.transcriptPath;
		return transcriptPath !== null && JSON.stringify(
			SessionManager.open(transcriptPath).getEntries(),
		).includes("The submitted turn completed after returning to the Owner.");
	});
	await waitForCondition(() => owner.status(agentId).run.phase === "dormant");
});

test("a Dormant Agent keeps commands available and starts one successor on editor submission", async (t) => {
	const host = await createTestOwnerHost(piAgentCoordination, {
		persistent: true,
		additionalExtensionFactories: [{
			name: "dormant-command-probe",
			hidden: true,
			factory(pi) {
				pi.registerCommand("mark-dormant-view", {
					description: "Prove the Dormant view accepts normal commands",
					async handler(_args, ctx) {
						ctx.ui.setWidget("dormant-command", [
							"Dormant command executed",
						]);
					},
				});
			},
		}],
	});
	t.after(() => host.runtime.dispose());
	host.model.setResponses([
		fauxAssistantMessage("Persist this response for interactive Dormant inspection."),
	]);
	const spawn = await executeAndCommitRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-dormant-agent-view",
		{
			request: "Become Dormant before the Owner inspects this transcript.",
			label: "Dormant Worker",
		},
	);
	const agentId = (spawn.details as { agentId: string }).agentId;
	await waitForCondition(async () =>
		JSON.stringify(await childEntries(host, agentId)).includes(
			"Persist this response for interactive Dormant inspection.",
		)
	);
	const termination = await executeAndCommitRegisteredTool(
		host.session,
		"agent_control",
		"terminate-before-dormant-agent-view",
		{ operation: "terminate", agentId },
	);
	assert.equal((termination.details as { disposition: string }).disposition, "terminated");
	const ownerSession = host.runtime.session;
	const ownerEditor = "Owner draft survives Dormant inspection";
	host.ui.setEditorText(ownerEditor);
	let successorModelRequests = 0;
	host.model.setResponses([
		() => {
			successorModelRequests += 1;
			return fauxAssistantMessage("The successor received the Dormant editor input.");
		},
	]);

	const { command, view } = await openDormantAgentView(host, agentId);
	await waitForCondition(() =>
		stripTerminalSequences(view.render(80).join("\n"))
			.replace(/\s+/g, "")
			.includes("PersistthisresponseforinteractiveDormantinspection")
	);
	const rendered = stripTerminalSequences(view.render(80).join("\n"));
	assert.match(rendered, /Dormant Worker/);
	assert.match(rendered, /dormant/);
	assert.match(rendered.replace(/\s+/g, ""), /PersistthisresponseforinteractiveDormantinspection/);
	assert.equal(host.runtime.session, ownerSession);
	assert.equal(host.ui.getEditorText(), ownerEditor);
	assert.equal(await currentRunPhase(host, agentId), "dormant");
	assert.equal(successorModelRequests, 0);

	for (const character of "/mark-dormant-view") view.handleInput?.(character);
	view.handleInput?.("\r");
	await waitForCondition(() =>
		stripTerminalSequences(view.render(80).join("\n")).includes(
			"Dormant command executed",
		)
	);
	assert.equal(await currentRunPhase(host, agentId), "dormant");
	assert.equal(successorModelRequests, 0);

	for (const character of "Direction submitted from the Dormant Agent editor.") {
		view.handleInput?.(character);
	}
	view.handleInput?.("\r");
	await waitForCondition(async () =>
		JSON.stringify(await childEntries(host, agentId)).includes(
			"The successor received the Dormant editor input.",
		)
	);
	assert.equal(successorModelRequests, 1);
	assert.equal(
		(await childEntries(host, agentId)).filter(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "user" &&
				JSON.stringify(entry.message.content).includes(
					"Direction submitted from the Dormant Agent editor.",
				),
		).length,
		1,
	);
	assert.equal(await currentRunPhase(host, agentId), "live");
	assert.match(
		stripTerminalSequences(view.render(80).join("\n")),
		/The successor received the Dormant editor input/,
	);
	assert.equal(host.ui.getEditorText(), ownerEditor);

	for (const character of "/agents") view.handleInput?.(character);
	view.handleInput?.("\r");
	await waitForCondition(() =>
		stripTerminalSequences(view.render(80).join("\n")).includes("Tab views")
	);
	view.handleInput?.("k");
	view.handleInput?.("\r");
	await command;
	assert.equal(await hasRetention(host, agentId, "interactive_selection"), false);
	assert.equal(host.runtime.session, ownerSession);
	assert.equal(host.ui.getEditorText(), ownerEditor);
});

test("a Dormant command activates the already-attached Agent runtime once", async (t) => {
	const submittedText = "Start the successor from a Dormant slash command.";
	let childSessionStarts = 0;
	const host = await createTestOwnerHost(piAgentCoordination, {
		persistent: true,
		additionalExtensionFactories: [{
			name: "dormant-command-message-probe",
			hidden: true,
			factory(pi) {
				pi.on("session_start", (_event, ctx) => {
					if (ctx.sessionManager.getEntries().some((entry) =>
						entry.type === "custom" &&
						entry.customType === "agent-coordination.identity"
					)) childSessionStarts += 1;
				});
				pi.registerCommand("wake-dormant-agent", {
					description: "Emit one user message from the Dormant command",
					async handler() {
						pi.sendUserMessage(submittedText);
					},
				});
			},
		}],
	});
	t.after(() => host.runtime.dispose());
	host.model.setResponses([
		fauxAssistantMessage("Initial Run settles before command-driven startup."),
	]);
	const spawn = await executeAndCommitRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-dormant-command-message-agent",
		{
			request: "Become Dormant before command-driven startup.",
			label: "Dormant Command Worker",
		},
	);
	const agentId = (spawn.details as { agentId: string }).agentId;
	await waitForCondition(async () =>
		JSON.stringify(await childEntries(host, agentId)).includes(
			"Initial Run settles before command-driven startup.",
		)
	);
	await executeAndCommitRegisteredTool(
		host.session,
		"agent_control",
		"terminate-before-dormant-command-message",
		{ operation: "terminate", agentId },
	);
	let successorModelRequests = 0;
	host.model.setResponses([() => {
		successorModelRequests += 1;
		return fauxAssistantMessage("The command-emitted user message was processed.");
	}]);

	const opened = await openDormantAgentView(host, agentId);
	assert.equal(await currentRunPhase(host, agentId), "dormant");
	await waitForCondition(() => childSessionStarts === 2);
	const passiveTermination = await executeAndCommitRegisteredTool(
		host.session,
		"agent_control",
		"terminate-prepared-dormant-runtime",
		{ operation: "terminate", agentId },
	);
	assert.equal(
		(passiveTermination.details as { disposition: string }).disposition,
		"not_running",
	);
	for (const character of "/wake-dormant-agent") {
		opened.view.handleInput?.(character);
	}
	opened.view.handleInput?.("\r");
	await waitForCondition(async () =>
		JSON.stringify(await childEntries(host, agentId)).includes(
			"The command-emitted user message was processed.",
		)
	);
	const entries = await childEntries(host, agentId);
	assert.equal(
		entries.filter(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "user" &&
				JSON.stringify(entry.message.content).includes(submittedText),
		).length,
		1,
	);
	assert.equal(successorModelRequests, 1);
	assert.equal(await currentRunPhase(host, agentId), "live");
	assert.equal(childSessionStarts, 2);
	await returnAgentViewToOwner(host, opened.view, opened.command);
});

test("Dormant session_start input activates the same attached Agent runtime", async (t) => {
	let childSessionStarts = 0;
	const host = await createTestOwnerHost(piAgentCoordination, {
		persistent: true,
		additionalExtensionFactories: [{
			name: "dormant-runtime-startup-modal",
			hidden: true,
			factory(pi) {
				pi.on("session_start", async (_event, ctx) => {
					if (!ctx.sessionManager.getEntries().some((entry) =>
						entry.type === "custom" &&
						entry.customType === "agent-coordination.identity"
					)) return;
					childSessionStarts += 1;
					if (childSessionStarts !== 2) return;
					pi.sendUserMessage(
						"Dormant session_start input activates this Agent runtime.",
					);
					await ctx.ui.confirm(
						"Dormant Runtime startup",
						"Finish opening the Dormant Agent presentation?",
					);
				});
			},
		}],
	});
	t.after(async () => host.runtime.dispose());
	host.model.setResponses([
		fauxAssistantMessage("Initial Run settles before Dormant Runtime."),
		fauxAssistantMessage("The session_start input activated this same runtime."),
	]);
	const spawn = await executeAndCommitRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-dormant-runtime-modal",
		{
			request: "Settle before the Owner selects this Dormant Agent.",
			label: "Dormant Runtime Modal Worker",
		},
	);
	const agentId = (spawn.details as { agentId: string }).agentId;
	await waitForCondition(async () =>
		JSON.stringify(await childEntries(host, agentId)).includes(
			"Initial Run settles before Dormant Runtime.",
		)
	);
	await executeAndCommitRegisteredTool(
		host.session,
		"agent_control",
		"terminate-before-dormant-runtime-modal",
		{ operation: "terminate", agentId },
	);

	const opening = openDormantAgentView(host, agentId);
	const { command, view } = await opening;
	await waitForCondition(() =>
		stripTerminalSequences(view.render(80).join("\n")).includes(
			"Dormant Runtime startup",
		)
	);
	assert.equal(await currentRunPhase(host, agentId), "dormant");
	view.handleInput?.("\r");
	await waitForCondition(() =>
		!stripTerminalSequences(view.render(80).join("\n")).includes(
			"Dormant Runtime startup",
		)
	);
	await waitForCondition(async () =>
		JSON.stringify(await childEntries(host, agentId)).includes(
			"The session_start input activated this same runtime.",
		)
	);
	assert.equal(await currentRunPhase(host, agentId), "live");
	assert.equal(childSessionStarts, 2);
	await returnAgentViewToOwner(host, view, command);
});

test("closing a Dormant session_start modal cancels view initialization without modal input", async (t) => {
	let selectedAgentId = "";
	let childSessionStarts = 0;
	let childSessionShutdowns = 0;
	const selectedStartupLifecycle: string[] = [];
	let releaseSelectedStartupUI: () => void = () => undefined;
	let releaseCustomFactory!: () => void;
	const customFactoryGate = new Promise<void>((resolve) => {
		releaseCustomFactory = resolve;
	});
	let customComponentDisposals = 0;
	let markSelectedStartupModal!: () => void;
	const selectedStartupModal = new Promise<void>((resolve) => {
		markSelectedStartupModal = resolve;
	});
	const host = await createUnboundTestOwnerHost(() => undefined, {
		persistent: true,
		additionalExtensionFactories: [{
			name: "selection-startup-close-probe",
			hidden: true,
			factory(pi) {
				pi.on("session_start", async (_event, ctx) => {
					if (ctx.sessionManager.getSessionId() !== selectedAgentId) return;
					childSessionStarts += 1;
					if (childSessionStarts !== 2) return;
					markSelectedStartupModal();
					await ctx.ui.custom<void>(
						async (_tui, _theme, _keybindings, done) => {
							releaseSelectedStartupUI = done;
							await customFactoryGate;
							return {
								render: () => ["Selection startup close gate"],
								invalidate() {},
								handleInput() {},
								dispose() {
									customComponentDisposals += 1;
								},
							};
						},
						{ overlay: true },
					);
					selectedStartupLifecycle.push("session_start_after_ui");
					ctx.ui.setWidget("late-startup-state", ["Must be cleared after startup finishes"]);
				});
				pi.on("session_shutdown", (_event, ctx) => {
					if (ctx.sessionManager.getSessionId() !== selectedAgentId) return;
					childSessionShutdowns += 1;
					if (childSessionShutdowns === 2) {
						selectedStartupLifecycle.push("session_shutdown");
					}
				});
			},
		}],
	});
	const identity = adoptOrValidateOwnerIdentity(
		host.runtime,
		"<inline:pi-agent-coordination>",
	);
	let coordinator!: WorkflowCoordinator;
	coordinator = new WorkflowCoordinator(host.runtime, identity, {
		entryModulePath: "<inline:pi-agent-coordination>",
		spawnBoundaryHooks: {
			afterIdentityCommit: ({ identity: childIdentity }) => {
				selectedAgentId = childIdentity.agentId;
			},
		},
	});
	await bindTestOwnerHost(host, "tui");
	const owner = coordinator.forAgent(identity.agentId);
	let activeView: Awaited<ReturnType<typeof owner.openAgentView>>;
	t.after(async () => {
		releaseSelectedStartupUI();
		releaseCustomFactory();
		await activeView?.close();
		await coordinator.shutdown(async () => host.runtime.dispose());
	});
	const spawnInput = {
		request: "Become Dormant before testing startup cancellation.",
		label: "Startup Close Worker",
	};
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_spawn", spawnInput, { id: "spawn-startup-close-worker" }),
			{ stopReason: "toolUse" },
		),
	);
	host.model.setResponses([
		fauxAssistantMessage("The initial startup-close Run settles."),
	]);
	const spawn = await owner.spawn("spawn-startup-close-worker", spawnInput);
	assert.ok("agentId" in spawn && spawn.agentId);
	const agentId = spawn.agentId;
	selectedAgentId = agentId;
	await waitForCondition(() => {
		const run = owner.status(agentId).run;
		return run.phase === "live" && run.work === "settled";
	});
	const terminateInput = {
		operation: "terminate" as const,
		agentId,
	};
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_control", terminateInput, {
				id: "terminate-startup-close-worker",
			}),
			{ stopReason: "toolUse" },
		),
	);
	await owner.control("terminate-startup-close-worker", terminateInput);

	activeView = await owner.openAgentView(agentId);
	assert.ok(activeView);
	await selectedStartupModal;
	const closing = activeView.close();
	const closeOutcome = await Promise.race([
		closing.then(() => "closed" as const),
		new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 500)),
	]);
	if (closeOutcome === "blocked") {
		releaseSelectedStartupUI();
		await closing;
	}
	assert.equal(
		closeOutcome,
		"closed",
		"view closure must not wait for hidden Dormant UI input",
	);
	assert.equal(owner.status(agentId).run.phase, "dormant");
	assert.equal(childSessionStarts, 2);
	assert.equal(childSessionShutdowns, 2);
	assert.deepEqual(selectedStartupLifecycle, [
		"session_start_after_ui",
		"session_shutdown",
	]);
	releaseCustomFactory();
	await waitForCondition(() => customComponentDisposals === 1);
	assert.equal(
		owner.status(agentId).run.retentionReasons.some(
			({ reason }) => reason === "interactive_selection",
		),
		false,
	);
});

test("Workflow shutdown cancels unselected Message-started session_start UI before Agent lanes", async (t) => {
	let childAgentId = "";
	let childSessionStarts = 0;
	let childSessionShutdowns = 0;
	const startupLifecycle: string[] = [];
	let releaseStartupUI: () => void = () => undefined;
	let markStartupUI!: () => void;
	const startupUI = new Promise<void>((resolve) => {
		markStartupUI = resolve;
	});
	const host = await createUnboundTestOwnerHost(() => undefined, {
		persistent: true,
		additionalExtensionFactories: [{
			name: "unselected-startup-shutdown-probe",
			hidden: true,
			factory(pi) {
				pi.on("session_start", async (_event, ctx) => {
					if (ctx.sessionManager.getSessionId() !== childAgentId) return;
					childSessionStarts += 1;
					if (childSessionStarts !== 2) return;
					markStartupUI();
					await ctx.ui.custom<void>(
						(_tui, _theme, _keybindings, done) => {
							releaseStartupUI = done;
							return {
								render: () => ["Unselected Message startup gate"],
								invalidate() {},
								handleInput() {},
							};
						},
						{ overlay: true },
					);
					startupLifecycle.push("session_start_after_ui");
				});
				pi.on("session_shutdown", (_event, ctx) => {
					if (ctx.sessionManager.getSessionId() !== childAgentId) return;
					childSessionShutdowns += 1;
					if (childSessionShutdowns === 2) startupLifecycle.push("session_shutdown");
				});
			},
		}],
	});
	const identity = adoptOrValidateOwnerIdentity(
		host.runtime,
		"<inline:pi-agent-coordination>",
	);
	let coordinator!: WorkflowCoordinator;
	coordinator = new WorkflowCoordinator(host.runtime, identity, {
		entryModulePath: "<inline:pi-agent-coordination>",
		spawnBoundaryHooks: {
			afterIdentityCommit: ({ identity: childIdentity }) => {
				childAgentId = childIdentity.agentId;
			},
		},
	});
	await bindTestOwnerHost(host, "tui");
	const owner = coordinator.forAgent(identity.agentId);
	let shutdown: Promise<void> | undefined;
	t.after(async () => {
		releaseStartupUI();
		await shutdown;
		if (!shutdown) await coordinator.shutdown(async () => host.runtime.dispose());
	});
	const appendToolSource = (
		toolName: string,
		toolCallId: string,
		input: Record<string, unknown>,
	) => {
		host.session.sessionManager.appendMessage(
			fauxAssistantMessage(
				fauxToolCall(toolName, input, { id: toolCallId }),
				{ stopReason: "toolUse" },
			),
		);
	};
	host.model.setResponses([
		fauxAssistantMessage("Initial unselected-shutdown Run settles."),
		fauxAssistantMessage("Cleanup Delivery completes if startup is not canceled."),
	]);
	const spawnInput = {
		request: "Become Dormant before unselected Message startup.",
		label: "Unselected Startup Worker",
	};
	appendToolSource("agent_spawn", "spawn-unselected-startup-worker", spawnInput);
	const spawn = await owner.spawn("spawn-unselected-startup-worker", spawnInput);
	assert.ok("agentId" in spawn && spawn.agentId);
	const agentId = spawn.agentId;
	await waitForCondition(() => {
		const run = owner.status(agentId).run;
		return run.phase === "live" && run.work === "settled";
	});
	const terminateInput = { operation: "terminate" as const, agentId };
	appendToolSource(
		"agent_control",
		"terminate-unselected-startup-worker",
		terminateInput,
	);
	await owner.control("terminate-unselected-startup-worker", terminateInput);
	const messageInput = {
		operation: "send" as const,
		targetAgentId: agentId,
		content: "Start an unselected successor and wait in startup UI.",
	};
	appendToolSource("agent_message", "message-starts-unselected-ui", messageInput);
	const messaging = owner.message("message-starts-unselected-ui", messageInput);
	await startupUI;

	shutdown = coordinator.shutdown(async () => host.runtime.dispose());
	const shutdownOutcome = await Promise.race([
		shutdown.then(() => "closed" as const),
		new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 500)),
	]);
	if (shutdownOutcome === "blocked") {
		releaseStartupUI();
		await Promise.allSettled([messaging, shutdown]);
	}
	assert.equal(
		shutdownOutcome,
		"closed",
		"Workflow shutdown must cancel startup UI before waiting for an unselected Agent lane",
	);
	await messaging;
	assert.equal(childSessionStarts, 2);
	assert.equal(childSessionShutdowns, 2);
	assert.deepEqual(startupLifecycle, ["session_start_after_ui", "session_shutdown"]);
});

test("/agents switches the mounted durable view between independent child modes", async (t) => {
	const host = await createTestOwnerHost(piAgentCoordination, {
		persistent: true,
		additionalExtensionFactories: [{
			name: "independent-agent-mode-probe",
			hidden: true,
			factory(pi) {
				pi.on("session_start", (_event, ctx) => {
					const identity = ctx.sessionManager.getSessionId();
					ctx.ui.setFooter(() => new Text(`Independent footer · ${identity}`, 0, 0));
				});
				pi.registerShortcut("alt+q", {
					description: "Mark this exact child from its native shortcut path",
					handler(ctx) {
						const identity = ctx.sessionManager.getSessionId();
						ctx.ui.setWidget("independent-shortcut-marker", [
							`Independent shortcut · ${identity}`,
						]);
					},
				});
				pi.registerCommand("mark-independent-view", {
					description: "Mark this exact child mode",
					async handler(_args, ctx) {
						const identity = ctx.sessionManager.getSessionId();
						ctx.ui.setWidget("independent-mode-marker", [
							`Independent widget · ${identity}`,
						]);
					},
				});
			},
		}],
	});
	t.after(() => host.runtime.dispose());
	host.model.setResponses([
		fauxAssistantMessage("First switch target is ready."),
		fauxAssistantMessage("Second switch target is ready."),
	]);
	const firstSpawn = await executeAndCommitRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-first-switch-target",
		{ request: "Remain available as the first switch target.", label: "First Target" },
	);
	const secondSpawn = await executeAndCommitRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-second-switch-target",
		{ request: "Remain available as the second switch target.", label: "Second Target" },
	);
	const firstAgentId = (firstSpawn.details as { agentId: string }).agentId;
	const secondAgentId = (secondSpawn.details as { agentId: string }).agentId;
	await waitForCondition(async () =>
		JSON.stringify(await childEntries(host, firstAgentId)).includes("First switch target") &&
		JSON.stringify(await childEntries(host, secondAgentId)).includes("Second switch target")
	);

	const { command, view } = await openSelectedAgentView(host, firstAgentId);
	view.handleInput?.("\x1bq");
	await waitForCondition(() =>
		stripTerminalSequences(view.render(80).join("\n")).includes(
			`Independent shortcut · ${firstAgentId}`,
		)
	);
	for (const character of "/mark-independent-view") view.handleInput?.(character);
	view.handleInput?.("\r");
	await waitForCondition(() =>
		stripTerminalSequences(view.render(80).join("\n")).includes(
			`Independent widget · ${firstAgentId}`,
		)
	);
	for (const character of "/agents") view.handleInput?.(character);
	view.handleInput?.("\r");
	await waitForCondition(() =>
		stripTerminalSequences(view.render(80).join("\n")).includes("Tab views")
	);
	view.handleInput?.("j");
	view.handleInput?.("\r");
	await waitForCondition(() => {
		const rendered = stripTerminalSequences(view.render(80).join("\n"));
		return rendered.includes("Second Target") && !rendered.includes("Tab views");
	});
	assert.equal(await hasRetention(host, firstAgentId, "interactive_selection"), false);
	assert.equal(await hasRetention(host, secondAgentId, "interactive_selection"), true);
	const secondFrame = stripTerminalSequences(view.render(80).join("\n"));
	assert.match(secondFrame, new RegExp(`Independent footer · ${secondAgentId}`));
	assert.doesNotMatch(secondFrame, new RegExp(`Independent widget · ${firstAgentId}`));
	assert.doesNotMatch(secondFrame, new RegExp(`Independent shortcut · ${firstAgentId}`));
	for (const character of "/mark-independent-view") view.handleInput?.(character);
	view.handleInput?.("\r");
	await waitForCondition(() =>
		stripTerminalSequences(view.render(80).join("\n")).includes(
			`Independent widget · ${secondAgentId}`,
		)
	);

	for (const character of "/agents") view.handleInput?.(character);
	view.handleInput?.("\r");
	await waitForCondition(() =>
		stripTerminalSequences(view.render(80).join("\n")).includes("Tab views")
	);
	view.handleInput?.("k");
	view.handleInput?.("\r");
	await waitForCondition(() => {
		const rendered = stripTerminalSequences(view.render(80).join("\n"));
		return rendered.includes("First Target") && !rendered.includes("Tab views");
	});
	assert.equal(await hasRetention(host, firstAgentId, "interactive_selection"), true);
	assert.equal(await hasRetention(host, secondAgentId, "interactive_selection"), false);
	const restoredFirstFrame = stripTerminalSequences(view.render(80).join("\n"));
	assert.match(restoredFirstFrame, new RegExp(`Independent footer · ${firstAgentId}`));
	assert.match(restoredFirstFrame, new RegExp(`Independent widget · ${firstAgentId}`));
	assert.doesNotMatch(
		restoredFirstFrame,
		new RegExp(`Independent widget · ${secondAgentId}`),
	);

	for (const character of "/agents") view.handleInput?.(character);
	view.handleInput?.("\r");
	await waitForCondition(() =>
		stripTerminalSequences(view.render(80).join("\n")).includes("Tab views")
	);
	view.handleInput?.("k");
	view.handleInput?.("\r");
	await command;
});

test("later Runtime preparations use reloaded factories without mutating a retained mode", async () => {
	const createFactory = (generation: "original" | "replacement"): ExtensionFactory =>
		(pi) => {
			pi.on("session_start", (_event, ctx) => {
				ctx.ui.setFooter(() => new Text(
					`Factory generation · ${generation} · ${ctx.sessionManager.getSessionId()}`,
					0,
					0,
				));
			});
		};
	const descriptor = {
		name: "retained-resource-reload-probe",
		factory: createFactory("original"),
	};
	const host = await createTestOwnerHost(piAgentCoordination, {
		persistent: true,
		additionalExtensionFactories: [descriptor],
	});
	host.model.setResponses([
		fauxAssistantMessage("Original resource Run remains retained."),
		fauxAssistantMessage("Replacement resource Run is ready."),
	]);
	const firstSpawn = await executeAndCommitRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-original-resource-view",
		{ request: "Retain the original extension mode.", label: "Original Resource" },
	);
	const firstAgentId = (firstSpawn.details as { agentId: string }).agentId;
	await waitForCondition(async () =>
		JSON.stringify(await childEntries(host, firstAgentId)).includes("remains retained")
	);
	const firstOpen = await openSelectedAgentView(host, firstAgentId);
	assert.match(
		stripTerminalSequences(firstOpen.view.render(80).join("\n")),
		/Factory generation · original/,
	);
	await returnAgentViewToOwner(host, firstOpen.view, firstOpen.command);

	descriptor.factory = createFactory("replacement");
	const secondSpawn = await executeAndCommitRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-replacement-resource-view",
		{ request: "Load the replacement extension mode.", label: "Replacement Resource" },
	);
	const secondAgentId = (secondSpawn.details as { agentId: string }).agentId;
	await waitForCondition(async () =>
		JSON.stringify(await childEntries(host, secondAgentId)).includes("Replacement resource")
	);
	const secondOpen = await openSelectedAgentView(host, secondAgentId);
	assert.match(
		stripTerminalSequences(secondOpen.view.render(80).join("\n")),
		/Factory generation · replacement/,
	);
	await returnAgentViewToOwner(host, secondOpen.view, secondOpen.command);

	const reopenedFirst = await openSelectedAgentView(host, firstAgentId);
	const retainedFrame = stripTerminalSequences(reopenedFirst.view.render(80).join("\n"));
	assert.match(retainedFrame, /Factory generation · original/);
	assert.doesNotMatch(retainedFrame, /Factory generation · replacement/);
	await returnAgentViewToOwner(host, reopenedFirst.view, reopenedFirst.command);
	await host.runtime.dispose();
});

test("a terminally failed viewed Run stays open on the durable Dormant Agent", async (t) => {
	const host = await createTestOwnerHost(piAgentCoordination, {
		persistent: true,
		implicitModeratorResponses: false,
		settings: { retry: { enabled: false } },
	});
	let markFailureStarted!: () => void;
	const failureStarted = new Promise<void>((resolve) => {
		markFailureStarted = resolve;
	});
	let releaseFailure!: () => void;
	const failureGate = new Promise<void>((resolve) => {
		releaseFailure = resolve;
	});
	t.after(async () => {
		releaseFailure();
		await host.runtime.dispose();
	});
	const routeResponse = async (context: { messages: unknown; tools?: Array<{ name: string }> }) => {
		const messages = JSON.stringify(context.messages);
		if (context.tools?.some(({ name }) => name === "moderator_control")) {
			return fauxAssistantMessage("The Moderator observed the failed obligation.");
		}
		if (messages.includes("Fail terminally while the durable Agent view remains open.")) {
			markFailureStarted();
			await failureGate;
			return fauxAssistantMessage("The viewed exact Run failed terminally.", {
				stopReason: "error",
				errorMessage: "deterministic viewed Run failure",
			});
		}
		return fauxAssistantMessage("The Owner input loop remains usable after viewed Run failure.");
	};
	host.model.setResponses(Array.from({ length: 12 }, () => routeResponse));
	const spawn = await executeAndCommitRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-failing-agent-view",
		{
			request: "Fail terminally while the durable Agent view remains open.",
			label: "Failing Worker",
		},
	);
	const agentId = (spawn.details as { agentId: string }).agentId;
	await failureStarted;
	const ownerSession = host.runtime.session;
	const { command, view } = await openSelectedAgentView(host, agentId);
	assert.match(stripTerminalSequences(view.render(80).join("\n")), /Failing Worker.*active/);

	releaseFailure();
	await waitForCondition(async () => await currentRunPhase(host, agentId) === "dormant");
	await waitForCondition(() =>
		stripTerminalSequences(view.render(80).join("\n")).includes("failed")
	);
	assert.equal(host.ui.customSurfaces[0], view);
	assert.equal(host.runtime.session, ownerSession);
	const dormantRendered = stripTerminalSequences(view.render(80).join("\n"));
	assert.match(dormantRendered, /Failing Worker.*failed/);
	assert.match(dormantRendered, /viewed exact Run failed terminally/);

	await host.session.prompt("Confirm the Owner input loop still runs.");
	await host.session.waitForIdle();
	assert.equal(host.runtime.session, ownerSession);
	assert.equal(host.ui.customSurfaces[0], view);

	await returnAgentViewToOwner(host, view, command);
	assert.equal(host.runtime.session, ownerSession);
});

test("repeated successor Runs reuse one selected Agent runtime and dispose its mode once", async () => {
	const sessionStarts: string[] = [];
	const sessionShutdowns: string[] = [];
	const baselineListeners = processListenerCounts();
	const baselineResources = processResourceCounts();
	const host = await createTestOwnerHost(piAgentCoordination, {
		persistent: true,
		implicitModeratorResponses: false,
		settings: { retry: { enabled: false } },
		additionalExtensionFactories: [{
			name: "successor-mode-lifecycle-probe",
			hidden: true,
			factory(pi) {
				pi.on("session_start", (_event, ctx) => {
					sessionStarts.push(ctx.sessionManager.getSessionId());
				});
				pi.on("session_shutdown", (_event, ctx) => {
					sessionShutdowns.push(ctx.sessionManager.getSessionId());
				});
			},
		}],
	});
	let releaseInitialFailure!: () => void;
	const initialFailureGate = new Promise<void>((resolve) => {
		releaseInitialFailure = resolve;
	});
	const routeFailure = async (context: {
		messages: unknown;
		tools?: Array<{ name: string }>;
	}) => {
		if (context.tools?.some(({ name }) => name === "moderator_control")) {
			return fauxAssistantMessage("Moderator observed repeated successor failure.");
		}
		const messages = JSON.stringify(context.messages);
		if (messages.includes("Wait for selection before the initial exact Run fails.")) {
			await initialFailureGate;
		}
		return fauxAssistantMessage("This exact successor Run failed as requested.", {
			stopReason: "error",
			errorMessage: "deterministic repeated successor failure",
		});
	};
	host.model.setResponses(Array.from({ length: 30 }, () => routeFailure));
	const spawn = await executeAndCommitRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-repeated-successor-worker",
		{
			request: "Wait for selection before the initial exact Run fails.",
			label: "Repeated Successor Worker",
		},
	);
	const agentId = (spawn.details as { agentId: string }).agentId;
	const opened = await openSelectedAgentView(host, agentId);
	releaseInitialFailure();
	await waitForCondition(async () => await currentRunPhase(host, agentId) === "dormant");
	await waitForCondition(() =>
		stripTerminalSequences(opened.view.render(80).join("\n")).includes("failed")
	);

	for (const input of ["Start exact successor one.", "Start exact successor two."]) {
		const startsBeforeSuccessor = sessionStarts.length;
		for (const character of input) opened.view.handleInput?.(character);
		opened.view.handleInput?.("\r");
		await waitForCondition(async () => await currentRunPhase(host, agentId) === "dormant");
		await waitForCondition(() => {
			const frame = stripTerminalSequences(opened.view.render(80).join("\n"));
			return frame.includes("failed") && frame.includes(input);
		});
		assert.equal(sessionStarts.length, startsBeforeSuccessor);
	}

	await returnAgentViewToOwner(host, opened.view, opened.command);
	await host.runtime.dispose();
	assert.equal(sessionStarts.length, 2, JSON.stringify(sessionStarts));
	assert.deepEqual(
		[...sessionShutdowns].sort(),
		[...sessionStarts].sort(),
		JSON.stringify({ sessionStarts, sessionShutdowns }),
	);
	assert.deepEqual(processListenerCounts(), baselineListeners);
	await waitForCondition(() => {
		try {
			assertNoProcessResourceGrowth(baselineResources, processResourceCounts());
			return true;
		} catch {
			return false;
		}
	});
	assertNoProcessResourceGrowth(baselineResources, processResourceCounts());
});

test("an ordinary Message activates the already-open Agent runtime before execution", async (t) => {
	let childSessionStarts = 0;
	const host = await createTestOwnerHost(piAgentCoordination, {
		persistent: true,
		additionalExtensionFactories: [{
			name: "message-runtime-identity-probe",
			hidden: true,
			factory(pi) {
				pi.on("session_start", (_event, ctx) => {
					if (ctx.sessionManager.getEntries().some((entry) =>
						entry.type === "custom" &&
						entry.customType === "agent-coordination.identity"
					)) childSessionStarts += 1;
				});
			},
		}],
	});
	let releaseInitialFailure!: () => void;
	const initialFailureGate = new Promise<void>((resolve) => {
		releaseInitialFailure = resolve;
	});
	let markInitialFailureStarted!: () => void;
	const initialFailureStarted = new Promise<void>((resolve) => {
		markInitialFailureStarted = resolve;
	});
	let releaseSuccessor!: () => void;
	const successorGate = new Promise<void>((resolve) => {
		releaseSuccessor = resolve;
	});
	t.after(async () => {
		releaseInitialFailure();
		releaseSuccessor();
		await host.runtime.dispose();
	});
	let view!: Component;
	let markSuccessorExecutionStarted!: () => void;
	const successorExecutionStarted = new Promise<void>((resolve) => {
		markSuccessorExecutionStarted = resolve;
	});
	let attachedBeforeExecution = false;
	let initialFailureProduced = false;
	const routeSuccessor = async (context: { messages: unknown; tools?: Array<{ name: string }> }) => {
		const messages = JSON.stringify(context.messages);
		if (context.tools?.some(({ name }) => name === "moderator_control")) {
			return fauxAssistantMessage("Moderator background work remains independent.");
		}
		if (
			!initialFailureProduced &&
			messages.includes("Fail while selected before ordinary Message delivery.")
		) {
			initialFailureProduced = true;
			markInitialFailureStarted();
			await initialFailureGate;
			return fauxAssistantMessage("The initially selected Run failed.", {
				stopReason: "error",
				errorMessage: "deterministic failure before Message successor",
			});
		}
		if (messages.includes("Start the successor through ordinary Message delivery.")) {
			const rendered = stripTerminalSequences(view.render(80).join("\n"))
				.replace(/\s+/g, "");
			attachedBeforeExecution =
				host.ui.customSurfaces[0] === view &&
				rendered.includes("SuccessorWorker") &&
				rendered.includes("active") &&
				rendered.includes("StartthesuccessorthroughordinaryMessagedelivery.");
			markSuccessorExecutionStarted();
			await successorGate;
			return fauxAssistantMessage("The Message-started successor completed.");
		}
		return fauxAssistantMessage("Unrelated Owner work remained on the Owner session.");
	};
	host.model.setResponses(Array.from({ length: 16 }, () => routeSuccessor));
	const spawn = await executeAndCommitRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-message-successor-view",
		{
			request: "Fail while selected before ordinary Message delivery.",
			label: "Successor Worker",
		},
	);
	const agentId = (spawn.details as { agentId: string }).agentId;
	await initialFailureStarted;
	const ownerSession = host.runtime.session;
	const opened = await openSelectedAgentView(host, agentId);
	view = opened.view;
	releaseInitialFailure();
	await waitForCondition(async () => await currentRunPhase(host, agentId) === "dormant");
	await waitForCondition(() =>
		stripTerminalSequences(view.render(80).join("\n")).includes("failed")
	);

	const sent = await executeAndCommitRegisteredTool(
		host.session,
		"agent_message",
		"message-starts-viewed-successor",
		{
			operation: "send",
			targetAgentId: agentId,
			content: "Start the successor through ordinary Message delivery.",
		},
	);
	assert.equal((sent.details as { delivery: string }).delivery, "pending");
	await successorExecutionStarted;
	assert.equal(attachedBeforeExecution, true);
	assert.equal(host.runtime.session, ownerSession);
	assert.equal(host.ui.customSurfaces[0], view);
	assert.equal(await currentRunPhase(host, agentId), "live");
	assert.equal(await hasRetention(host, agentId, "interactive_selection"), true);
	assert.equal(childSessionStarts, 1);

	releaseSuccessor();
	await waitForCondition(async () =>
		JSON.stringify(await childEntries(host, agentId)).includes(
			"The Message-started successor completed.",
		)
	);
	await returnAgentViewToOwner(host, view, opened.command);
	assert.equal(host.runtime.session, ownerSession);
	assert.equal(await hasRetention(host, agentId, "interactive_selection"), false);
});

test("Workflow shutdown disposes an open overlay once without disposing its live projection twice", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, { persistent: true });
	host.model.setResponses([
		fauxAssistantMessage("Keep this live projection retained for host-driven view disposal."),
	]);
	const spawn = await executeAndCommitRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-host-disposed-agent-view",
		{
			request: "Remain retained while Workflow shutdown closes the overlay.",
			label: "Shutdown Worker",
		},
	);
	const agentId = (spawn.details as { agentId: string }).agentId;
	await waitForCondition(async () =>
		JSON.stringify(await childEntries(host, agentId)).includes(
			"Keep this live projection retained for host-driven view disposal.",
		)
	);
	const { command, view } = await openSelectedAgentView(host, agentId);
	assert.equal(host.ui.customSurfaces[0], view);

	await host.runtime.dispose();
	await command;
	assert.equal(host.ui.customSurfaces.length, 0);
});

async function openSelectedAgentView(
	host: TestOwnerHost,
	agentId: string,
): Promise<Readonly<{ command: Promise<void>; view: Component }>> {
	const { command, surface: selector } = await openAgentsSurface(host);
	if (!selectAgentInCurrentTree(selector, agentId, host.session.sessionId)) {
		selector.handleInput?.("\x1b");
		await command;
		assert.fail(`Agent ${agentId} is absent from the Live selector hierarchy`);
	}
	await Promise.race([
		waitForCondition(() =>
			host.ui.customSurfaces.length === 1 && host.ui.customSurfaces[0] !== selector
		),
		command.then(() => {
			throw new Error("/agents closed before the Agent view opened");
		}),
	]);
	return { command, view: host.ui.customSurfaces[0]! };
}

async function returnAgentViewToOwner(
	host: TestOwnerHost,
	view: Component,
	command: Promise<void>,
): Promise<void> {
	for (const character of "/agents") view.handleInput?.(character);
	view.handleInput?.("\r");
	await waitForCondition(() =>
		stripTerminalSequences(view.render(80).join("\n")).includes("Tab views")
	);
	const ownerPattern = new RegExp(
		`→ owner[\\s\\S]*${host.session.sessionId}`,
	);
	for (let tab = 0; tab < 2; tab += 1) {
		for (let step = 0; step < MAX_SELECTOR_NAVIGATION_STEPS; step += 1) {
			if (ownerPattern.test(stripTerminalSequences(view.render(80).join("\n")))) {
				view.handleInput?.("\r");
				await command;
				return;
			}
			view.handleInput?.("k");
		}
		view.handleInput?.("\t");
	}
	throw new Error("Owner is absent from the child /agents selector");
}

async function openDormantAgentView(
	host: TestOwnerHost,
	agentId: string,
): Promise<Readonly<{ command: Promise<void>; view: Component }>> {
	const { command, surface: selector } = await openAgentsSurface(host);
	selector.handleInput?.("\t");
	const firstRender = selector.render(80).join("\n");
	let currentRender = firstRender;
	for (let attempt = 0; attempt < MAX_SELECTOR_NAVIGATION_STEPS; attempt += 1) {
		if (focusedDetailsShowAgent(selector, agentId)) {
			selector.handleInput?.("\r");
			await waitForCondition(() =>
				host.ui.customSurfaces.length === 1 && host.ui.customSurfaces[0] !== selector
			);
			return { command, view: host.ui.customSurfaces[0]! };
		}
		selector.handleInput?.("j");
		currentRender = selector.render(80).join("\n");
		if (currentRender === firstRender) break;
	}
	selector.handleInput?.("\x1b");
	await command;
	assert.fail(`Dormant Agent ${agentId} is absent from the selector`);
}

function selectAgentInCurrentTree(
	surface: Component,
	targetAgentId: string,
	ownerAgentId: string,
): boolean {
	const firstRender = surface.render(80).join("\n");
	let currentRender = firstRender;
	do {
		if (focusedDetailsShowAgent(surface, targetAgentId)) {
			surface.handleInput?.("\r");
			return true;
		}
		if (!focusedDetailsShowAgent(surface, ownerAgentId)) {
			const beforeZoom = currentRender;
			surface.handleInput?.("l");
			const afterZoom = surface.render(80).join("\n");
			if (afterZoom !== beforeZoom) {
				if (selectAgentInCurrentTree(surface, targetAgentId, ownerAgentId)) return true;
				surface.handleInput?.("h");
			}
		}
		surface.handleInput?.("j");
		currentRender = surface.render(80).join("\n");
	} while (currentRender !== firstRender);
	return false;
}

function selectAgentByLabel(surface: Component, label: string): string | undefined {
	const firstRender = stripTerminalSequences(surface.render(80).join("\n"));
	let currentRender = firstRender;
	for (let attempt = 0; attempt < MAX_SELECTOR_NAVIGATION_STEPS; attempt += 1) {
		const lines = stripTerminalSequences(surface.render(80).join("\n")).split("\n");
		const selectedRow = lines.findIndex((line) => line.includes("→"));
		if (selectedRow >= 0 && lines[selectedRow]?.includes(label)) {
			const agentId = lines
				.slice(selectedRow + 1, selectedRow + 5)
				.map((line) => line.slice(1, -1).trim())
				.find((line) => /^[0-9a-f-]{36}$/i.test(line));
			surface.handleInput?.("\r");
			return agentId;
		}
		surface.handleInput?.("j");
		const nextRender = stripTerminalSequences(surface.render(80).join("\n"));
		if (nextRender === currentRender || nextRender === firstRender) break;
		currentRender = nextRender;
	}
	return undefined;
}

function focusedDetailsShowAgent(surface: Component, targetAgentId: string): boolean {
	const lines = surface.render(80);
	const selectedRow = lines.findIndex((line) => line.includes("→"));
	if (selectedRow < 0) return false;
	return lines
		.slice(selectedRow + 1, selectedRow + 5)
		.some((line) => line.slice(1, -1).trim() === targetAgentId);
}

async function hasRetention(
	host: TestOwnerHost,
	agentId: string,
	reason: string,
): Promise<boolean> {
	const observe = host.session.getToolDefinition("agent_observe");
	assert.ok(observe);
	const result = await observe.execute(
		`observe-${reason}-${Date.now()}`,
		{ operation: "status", agentId },
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	return (result.details as {
		run: { retentionReasons: Array<{ reason: string }> };
	}).run.retentionReasons.some((retention) => retention.reason === reason);
}

async function currentRunPhase(host: TestOwnerHost, agentId: string): Promise<string> {
	const observe = host.session.getToolDefinition("agent_observe");
	assert.ok(observe);
	const status = await observe.execute(
		`observe-run-phase-${Date.now()}`,
		{ operation: "status", agentId },
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	return (status.details as { run: { phase: string } }).run.phase;
}

async function childEntries(host: TestOwnerHost, agentId: string) {
	const observe = host.session.getToolDefinition("agent_observe");
	assert.ok(observe);
	const status = await observe.execute(
		`locate-child-transcript-${Date.now()}`,
		{ operation: "status", agentId },
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	const transcriptPath = (status.details as {
		primaryEvidence: { transcriptPath: string | null };
	}).primaryEvidence.transcriptPath;
	assert.ok(transcriptPath);
	return SessionManager.open(transcriptPath).getEntries();
}

function processListenerCounts(): Readonly<Record<string, number>> {
	return {
		SIGTERM: process.listenerCount("SIGTERM"),
		SIGHUP: process.listenerCount("SIGHUP"),
		uncaughtException: process.listenerCount("uncaughtException"),
	};
}

function processResourceCounts(): Readonly<Record<string, number>> {
	const counts: Record<string, number> = {};
	for (const resource of process.getActiveResourcesInfo()) {
		counts[resource] = (counts[resource] ?? 0) + 1;
	}
	return counts;
}

function assertNoProcessResourceGrowth(
	baseline: Readonly<Record<string, number>>,
	actual: Readonly<Record<string, number>>,
): void {
	for (const [resource, count] of Object.entries(actual)) {
		assert.ok(
			count <= (baseline[resource] ?? 0),
			`${resource} grew from ${baseline[resource] ?? 0} to ${count}`,
		);
	}
}

async function waitForCondition(predicate: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + SURFACE_WAIT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("Timed out waiting for Agent view state");
}
