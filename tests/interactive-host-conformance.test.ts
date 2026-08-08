import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";

import xtermHeadless from "@xterm/headless";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
	type Component,
	type Terminal,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import * as hostPi from "@earendil-works/pi-coding-agent";

import piAgentCoordination from "../src/index.ts";
import { readDetachedChildUIState } from "../src/pi-integration/extension-bindings.ts";
import { installInteractiveHostBridge } from "../src/pi-integration/interactive-host-bridge.ts";
import {
	resetSessionStartProbe,
	sessionStartReasons,
} from "./fixtures/session-start-probe-extension.ts";
import {
	executeAndCommitRegisteredTool,
	openAgentsSurface,
	selectAgent,
	selectDormantAgent,
} from "./support/agent-session.ts";
import {
	bindTestOwnerHost,
	createPiCliTestOwnerHost,
	createTestOwnerHost,
	createUnboundTestOwnerHost,
} from "./support/pi-host.ts";

const SESSION_START_PROBE = fileURLToPath(
	new URL("./fixtures/session-start-probe-extension.ts", import.meta.url),
);
const { Terminal: XtermTerminal } = xtermHeadless;
const TERMINAL_COLUMNS = 80;
const TERMINAL_ROWS = 12;
const LLAMA_MODEL_ID = "local-conformance-model";

function selectedAgentStatus(
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
	agentId: string,
	label: string,
	phase: string,
): string | undefined {
	const marker = phase === "active" ? "● " : phase === "dormant" ? "○ " : "";
	const prefix = `${marker}${label} · `;
	const suffix = ` · ${phase}`;
	const matches = [...host.ui.statuses.values()].filter((value) =>
		value.startsWith(prefix) && value.endsWith(suffix)
	);
	if (matches.length !== 1) return undefined;
	const status = matches[0]!;
	const compactIdentity = status.slice(prefix.length, -suffix.length);
	return compactIdentity.length < agentId.length && agentId.endsWith(compactIdentity)
		? status
		: undefined;
}

test("selected Agent status follows native selection and semantic Run changes", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, { persistent: true });
	let markGenerationStarted!: () => void;
	const generationStarted = new Promise<void>((resolve) => {
		markGenerationStarted = resolve;
	});
	let releaseGeneration!: () => void;
	const generationGate = new Promise<void>((resolve) => {
		releaseGeneration = resolve;
	});
	host.model.setResponses([
		async () => {
			markGenerationStarted();
			await generationGate;
			return fauxAssistantMessage("The selected leaf settles after the status check.");
		},
	]);
	const spawned = await executeAndCommitRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-selected-status-leaf",
		{
			request: "Remain live while the selected footer status changes.",
			label: "Selected Leaf",
		},
	);
	const childAgentId = (spawned.details as { agentId: string }).agentId;
	await generationStarted;

	await selectAgent(host, childAgentId);
	assert.ok(selectedAgentStatus(host, childAgentId, "Selected Leaf", "active"));
	assert.equal(host.ui.widgets.size, 0);

	releaseGeneration();
	await host.runtime.session.waitForIdle();
	await waitForCondition(() =>
		selectedAgentStatus(host, childAgentId, "Selected Leaf", "settled") !== undefined
	);

	const held = await executeAndCommitRegisteredTool(
		host.session,
		"agent_control",
		"hold-selected-status-leaf",
		{ operation: "interrupt", agentId: childAgentId },
	);
	assert.equal((held.details as { disposition: string }).disposition, "held");
	assert.ok(selectedAgentStatus(host, childAgentId, "Selected Leaf", "held"));

	await selectAgent(host, host.session.sessionId);
	assert.equal(selectedAgentStatus(host, childAgentId, "Selected Leaf", "held"), undefined);
	await host.runtime.dispose();
});

test("selected Agent status exposes Human-waiting attention without changing the footer seam", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, { persistent: true });
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"ask_user_question",
				{
					questions: [{
						kind: "text",
						header: "Status check",
						prompt: "Which status should be shown?",
						multiline: false,
					}],
				},
				{ id: "selected-status-human-question" },
			),
			{ stopReason: "toolUse" },
		),
	]);
	const spawned = await executeAndCommitRegisteredTool(
		host.session,
		"agent_spawn",
		"spawn-selected-status-human",
		{ request: "Wait for the Human status projection.", label: "Human Waiter" },
	);
	const childAgentId = (spawned.details as { agentId: string }).agentId;
	await waitForRunAttention(host, childAgentId, "input_required");

	await selectAgent(host, childAgentId);
	assert.ok(selectedAgentStatus(host, childAgentId, "Human Waiter", "waiting (human)"));

	await selectAgent(host, host.session.sessionId);
	assert.equal(
		selectedAgentStatus(host, childAgentId, "Human Waiter", "waiting (human)"),
		undefined,
	);
	await host.runtime.dispose();
});

test("retained native selection refreshes bindings without replaying session startup", async () => {
	resetSessionStartProbe();
	const host = await createTestOwnerHost(piAgentCoordination, {
		persistent: true,
		additionalExtensionPaths: [SESSION_START_PROBE],
	});
	host.model.setResponses([
		fauxAssistantMessage("Remain live while native selection moves between Agents."),
	]);
	const childAgentId = await spawnRetainedChild(host);

	await selectAgent(host, childAgentId);
	const selectedChild = host.runtime.session;
	const observe = selectedChild.getToolDefinition("agent_observe");
	assert.ok(observe);
	const childStatus = await observe.execute(
		"observe-selected-child-closure",
		{ operation: "status" },
		undefined,
		undefined,
		selectedChild.extensionRunner.createContext(),
	);
	assert.equal((childStatus.details as { agentId: string }).agentId, childAgentId);
	const childCoordinationExtensions = host.runtime.services.resourceLoader
		.getExtensions()
		.extensions.filter((extension) => extension.tools.has("agent_spawn"));
	assert.equal(childCoordinationExtensions.length, 1);
	assert.equal(childCoordinationExtensions[0]?.hidden, true);
	assert.equal(
		childCoordinationExtensions[0]?.handlers.has("session_start"),
		false,
	);
	await selectAgent(host, host.session.sessionId);
	await selectAgent(host, childAgentId);

	assert.deepEqual(sessionStartReasons(host.session.sessionId), ["startup"]);
	assert.deepEqual(sessionStartReasons(childAgentId), ["startup"]);
	await host.runtime.dispose();
});

test("retained native selection restores third-party editor bindings", async () => {
	const editorFactories = new Map<string, unknown>();
	const host = await createTestOwnerHost(piAgentCoordination, {
		persistent: true,
		additionalExtensionFactories: [{
			name: "third-party-modal-editor",
			hidden: true,
			factory: (pi) => {
				pi.on("session_start", (_event, ctx) => {
					const editorFactory = () => undefined as never;
					editorFactories.set(ctx.sessionManager.getSessionId(), editorFactory);
					ctx.ui.setEditorComponent(editorFactory);
				});
			},
		}],
	});
	host.runtime.setBeforeSessionInvalidate(() => host.ui.setEditorComponent(undefined));
	const ownerEditorFactory = host.ui.getEditorComponent();
	assert.equal(ownerEditorFactory, editorFactories.get(host.session.sessionId));
	host.model.setResponses([
		fauxAssistantMessage("Remain live while the editor binding moves between Agents."),
	]);
	const childAgentId = await spawnRetainedChild(host);
	const childEditorFactory = editorFactories.get(childAgentId);
	assert.ok(childEditorFactory);
	// The child's session_start editor registration stays in its own context
	// instead of replacing the Owner's editor slot.
	assert.equal(host.ui.getEditorComponent(), ownerEditorFactory);

	await selectAgent(host, childAgentId);
	assert.equal(host.ui.getEditorComponent(), childEditorFactory);

	await selectAgent(host, host.session.sessionId);
	assert.equal(host.ui.getEditorComponent(), ownerEditorFactory);
	await host.runtime.dispose();
});

test("child session_start UI side effects stay in the child's detached context", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, {
		persistent: true,
		additionalExtensionFactories: [{
			name: "detached-child-ui-probe",
			hidden: true,
			factory: (pi) => {
				pi.on("session_start", (_event, ctx) => {
					ctx.ui.notify("startup-notice", "info");
					ctx.ui.setStatus("probe-status", "starting");
					ctx.ui.setWidget("probe-widget", ["probe-content"]);
					ctx.ui.setEditorComponent(() => undefined as never);
				});
			},
		}],
	});
	// Owner session_start behavior is unchanged: the probe reached the Owner TUI.
	assert.equal(host.ui.notifications.length, 1);
	assert.equal(host.ui.notifications[0]?.message, "startup-notice");
	const ownerEditorFactory = host.ui.getEditorComponent();
	const ownerStatusesBefore = new Map(host.ui.statuses);
	const ownerWidgetsBefore = new Map(host.ui.widgets);

	host.model.setResponses([
		fauxAssistantMessage("Remain live while child UI side effects stay detached."),
	]);
	const childAgentId = await spawnRetainedChild(host);

	// The child's session_start wrote into its own detached context only: no
	// notify, status, widget, or editor registration reached the Owner's TUI.
	assert.equal(host.ui.notifications.length, 1);
	assert.deepEqual(host.ui.statuses, ownerStatusesBefore);
	assert.deepEqual(host.ui.widgets, ownerWidgetsBefore);
	assert.equal(host.ui.getEditorComponent(), ownerEditorFactory);

	await selectAgent(host, childAgentId);
	const childState = readDetachedChildUIState(host.runtime.session);
	assert.equal(childState?.notifications.length, 1);
	assert.equal(childState?.notifications[0]?.message, "startup-notice");
	assert.equal(childState?.statuses.get("probe-status"), "starting");
	const probeWidget = childState?.widgets.get("probe-widget")?.content;
	assert.ok(Array.isArray(probeWidget));
	assert.deepEqual(probeWidget, ["probe-content"]);
	assert.ok(childState?.editorComponent);
	await host.runtime.dispose();
});

test("deselected child UI writes stay in the child's detached context", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, { persistent: true });
	host.model.setResponses([
		fauxAssistantMessage("Remain live while the deselected child writes detached UI state."),
	]);
	const childAgentId = await spawnRetainedChild(host);

	await selectAgent(host, childAgentId);
	const childSession = host.runtime.session;
	await selectAgent(host, host.session.sessionId);

	const editorBefore = host.ui.getEditorComponent();
	const childUi = childSession.extensionRunner.createContext().ui;
	childUi.notify("background-notice", "info");
	childUi.setStatus("background-status", "waiting");
	childUi.setWidget("background-widget", ["background-content"]);
	childUi.setEditorComponent(() => undefined as never);

	// A deselected child must not reach the Owner's presentation, even after a
	// native selection round-trip reinstalled its presentation context.
	assert.equal(host.ui.notifications.length, 0);
	assert.equal(host.ui.statuses.has("background-status"), false);
	assert.equal(host.ui.widgets.has("background-widget"), false);
	assert.equal(host.ui.getEditorComponent(), editorBefore);

	const childState = readDetachedChildUIState(childSession);
	assert.equal(childState?.notifications[0]?.message, "background-notice");
	assert.equal(childState?.statuses.get("background-status"), "waiting");
	assert.ok(childState?.widgets.has("background-widget"));
	await host.runtime.dispose();
});

test("interactive selection rejects ordinary termination until the Agent is deselected", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, { persistent: true });
	host.model.setResponses([
		fauxAssistantMessage("Remain live while interactive termination is checked."),
	]);
	const childAgentId = await spawnRetainedChild(host);

	await selectAgent(host, childAgentId);
	const selectedSession = host.runtime.session;
	const rejected = await executeAndCommitRegisteredTool(
		host.session,
		"agent_control",
		"reject-selected-child-termination",
		{
			operation: "terminate",
			agentId: childAgentId,
		},
	);

	assert.deepEqual(rejected.details, {
		agentId: childAgentId,
		disposition: "rejected",
		rejectionReason: "interactive_selection",
	});
	assert.equal(host.runtime.session, selectedSession);
	assert.equal(selectedSession.isIdle, true);

	await selectAgent(host, host.session.sessionId);
	const terminated = await executeAndCommitRegisteredTool(
		host.session,
		"agent_control",
		"terminate-deselected-child",
		{
			operation: "terminate",
			agentId: childAgentId,
		},
	);
	assert.equal(
		(terminated.details as { disposition: string }).disposition,
		"terminated",
	);
	await host.runtime.dispose();
});

test("queued native input commits before a later deselection can take the Agent lane", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, { persistent: true });
	host.model.setResponses([
		fauxAssistantMessage("Remain live until the native-input ordering check."),
	]);
	const childAgentId = await spawnRetainedChild(host);
	await selectAgent(host, childAgentId);
	const childSession = host.runtime.session;

	let markGenerationStarted!: () => void;
	const generationStarted = new Promise<void>((resolve) => {
		markGenerationStarted = resolve;
	});
	let releaseGeneration!: () => void;
	const generationGate = new Promise<void>((resolve) => {
		releaseGeneration = resolve;
	});
	host.model.setResponses([
		async () => {
			markGenerationStarted();
			await generationGate;
			return fauxAssistantMessage("The interrupted work reached its boundary.");
		},
		fauxAssistantMessage("The queued input ran after winning the Agent lane."),
	]);
	const activePrompt = childSession.prompt("Keep the selected Agent lane occupied.");
	await generationStarted;

	const interruption = executeAndCommitRegisteredTool(
		host.session,
		"agent_control",
		"interrupt-before-stale-native-input",
		{ operation: "interrupt", agentId: childAgentId },
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	const queuedText = "This queued input wins before the later deselection.";
	const queuedInput = childSession.prompt(queuedText);
	const deselection = selectAgent(host, host.session.sessionId);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(host.runtime.session, childSession);

	releaseGeneration();
	await activePrompt;
	assert.deepEqual((await interruption).details, {
		agentId: childAgentId,
		disposition: "held",
	});
	await queuedInput;
	await deselection;

	assert.equal(host.runtime.session, host.session);
	assert.equal(
		JSON.stringify(childSession.sessionManager.getEntries()).split(queuedText).length - 1,
		1,
	);
	await host.runtime.dispose();
});

test("deselection swallows later input from the obsolete Agent session", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, { persistent: true });
	host.model.setResponses([
		fauxAssistantMessage("Remain live until the obsolete-input check."),
	]);
	const childAgentId = await spawnRetainedChild(host);
	await selectAgent(host, childAgentId);
	const obsoleteSession = host.runtime.session;
	await selectAgent(host, host.session.sessionId);

	const staleInput = "This input arrived after the Agent lost Interactive Selection.";
	await obsoleteSession.prompt(staleInput);

	assert.equal(host.runtime.session, host.session);
	assert.equal(
		JSON.stringify(obsoleteSession.sessionManager.getEntries()).includes(staleInput),
		false,
	);
	await host.runtime.dispose();
});

test("termination that takes the Agent lane first leaves later selection Dormant", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, { persistent: true });
	let markGenerationStarted!: () => void;
	const generationStarted = new Promise<void>((resolve) => {
		markGenerationStarted = resolve;
	});
	let releaseGeneration!: () => void;
	const generationGate = new Promise<void>((resolve) => {
		releaseGeneration = resolve;
	});
	host.model.setResponses([
		async () => {
			markGenerationStarted();
			await generationGate;
			return fauxAssistantMessage("The terminated work reached its boundary.");
		},
	]);
	const childAgentId = await spawnRetainedChild(host);
	await generationStarted;

	const termination = executeAndCommitRegisteredTool(
		host.session,
		"agent_control",
		"terminate-before-native-selection",
		{ operation: "terminate", agentId: childAgentId },
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	const selection = selectAgent(host, childAgentId);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(host.runtime.session, host.session);

	releaseGeneration();
	assert.equal(
		((await termination).details as { disposition: string }).disposition,
		"terminated",
	);
	await selection;

	assert.equal(host.runtime.session.sessionId, childAgentId);
	assert.equal(
		await observeCurrentRunPhase(
			host,
			childAgentId,
			"observe-termination-first-selection",
		),
		"dormant",
	);
	await host.runtime.dispose();
});

test("failed native rebind restores the Dormant presentation and discards the successor", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, { persistent: true });
	host.model.setResponses([
		fauxAssistantMessage("Settle before the failed native rebind check."),
	]);
	const childAgentId = await spawnRetainedChild(host);
	await executeAndCommitRegisteredTool(
		host.session,
		"agent_control",
		"terminate-before-failed-native-rebind",
		{ operation: "terminate", agentId: childAgentId },
	);
	const { command, surface } = await openAgentsSurface(host);
	surface.handleInput?.("\t");
	assert.match(surface.render(80).join("\n"), new RegExp(childAgentId));
	surface.handleInput?.("\r");
	await command;
	const dormantPresentation = host.runtime.session;
	const evidenceBeforeInput = dormantPresentation.sessionManager
		.getEntries()
		.map(({ id }) => id);
	let failNextRebind = true;
	host.runtime.setRebindSession(async () => {
		if (!failNextRebind) return;
		failNextRebind = false;
		throw new Error("deterministic native rebind failure");
	});

	await dormantPresentation.prompt("Input whose successor cannot become visible.");

	assert.equal(host.runtime.session, dormantPresentation);
	assert.equal(
		await observeCurrentRunPhase(
			host,
			childAgentId,
			"observe-after-failed-native-rebind",
		),
		"dormant",
	);
	assert.deepEqual(
		dormantPresentation.sessionManager.getEntries().map(({ id }) => id),
		evidenceBeforeInput,
	);
	assert.match(
		host.ui.notifications.at(-1)?.message ?? "",
		/deterministic native rebind failure/,
	);

	await bindTestOwnerHost(host, "tui");
	await host.runtime.dispose();
});

test("Dormant focus is passive and Enter binds the Agent transcript without starting a Run", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, { persistent: true });
	host.model.setResponses([
		fauxAssistantMessage("Settle before becoming Dormant for native selection."),
	]);
	const childAgentId = await spawnRetainedChild(host);
	await executeAndCommitRegisteredTool(
		host.session,
		"agent_control",
		"terminate-before-dormant-selection",
		{
			operation: "terminate",
			agentId: childAgentId,
		},
	);
	const observed = await executeAndCommitRegisteredTool(
		host.session,
		"agent_observe",
		"locate-dormant-selection-transcript",
		{ operation: "status", agentId: childAgentId },
	);
	const transcriptPath = (observed.details as {
		primaryEvidence: { transcriptPath: string | null };
	}).primaryEvidence.transcriptPath;
	assert.ok(transcriptPath);
	const childManager = hostPi.SessionManager.open(transcriptPath);
	const evidenceBeforeSelection = childManager.getEntries().map(({ id }) => id);

	const { command, surface } = await openAgentsSurface(host);
	surface.handleInput?.("\t");
	assert.equal(host.runtime.session.sessionId, host.session.sessionId);
	assert.equal(
		host.session.sessionManager.getEntries().map(({ id }) => id).length > 0,
		true,
	);
	surface.handleInput?.("\r");
	await command;

	assert.equal(host.runtime.session.sessionId, childAgentId);
	const dormantPresentation = host.runtime.session;
	const reselection = await openAgentsSurface(host);
	const reselectionRendered = reselection.surface.render(80).join("\n");
	assert.match(reselectionRendered, /Dormant Agents/);
	assert.match(reselectionRendered, new RegExp(childAgentId));
	reselection.surface.handleInput?.("\r");
	await reselection.command;
	assert.equal(host.runtime.session, dormantPresentation);
	assert.ok(host.runtime.session.extensionRunner.getCommand("agents"));
	for (const toolName of [
		"agent_message",
		"agent_control",
		"agent_observe",
		"agent_spawn",
		"ask_user_question",
	]) {
		assert.equal(host.runtime.session.getToolDefinition(toolName), undefined);
	}
	host.model.setResponses([
		fauxAssistantMessage("A Dormant presentation must never invoke this response."),
	]);
	await host.runtime.session.prompt("Non-interactive presentation input.", {
		source: "rpc",
	});
	assert.deepEqual(
		host.runtime.session.sessionManager.getEntries().map(({ id }) => id),
		evidenceBeforeSelection,
	);
	assert.equal(
		await observeCurrentRunPhase(
			host,
			childAgentId,
			"observe-dormant-native-selection",
		),
		"dormant",
	);
	assert.deepEqual(
		host.runtime.session.sessionManager.getEntries().map(({ id }) => id),
		evidenceBeforeSelection,
	);
	await host.runtime.dispose();
});

test("an ordinary Message starts and selects the successor of a selected Dormant Agent", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, { persistent: true });
	host.model.setResponses([
		fauxAssistantMessage("Settle before the Message-started successor check."),
	]);
	const childAgentId = await spawnRetainedChild(host);
	await executeAndCommitRegisteredTool(
		host.session,
		"agent_control",
		"terminate-before-message-started-successor",
		{ operation: "terminate", agentId: childAgentId },
	);

	const { command, surface } = await openAgentsSurface(host);
	surface.handleInput?.("\t");
	assert.match(surface.render(80).join("\n"), new RegExp(childAgentId));
	surface.handleInput?.("\r");
	await command;
	const dormantPresentation = host.runtime.session;

	host.model.setResponses([
		fauxAssistantMessage("The selected Agent received its Message in one successor."),
	]);
	const sent = await executeAndCommitRegisteredTool(
		host.session,
		"agent_message",
		"message-starts-selected-successor",
		{
			operation: "send",
			targetAgentId: childAgentId,
			content: "Start the selected Agent through an ordinary Message.",
		},
	);

	assert.equal((sent.details as { delivery: string }).delivery, "pending");
	assert.notEqual(host.runtime.session, dormantPresentation);
	assert.equal(host.runtime.session.sessionId, childAgentId);
	await host.runtime.session.waitForIdle();
	assert.match(
		JSON.stringify(host.runtime.session.sessionManager.getEntries()),
		/Start the selected Agent through an ordinary Message\./,
	);
	await host.runtime.dispose();
});

test("native editor input starts a dormant successor with its named inline extensions", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, {
		persistent: true,
		additionalExtensionFactories: [{
			name: "llama.cpp",
			hidden: true,
			factory: () => undefined,
		}],
	});
	host.model.setResponses([
		fauxAssistantMessage("The initial named-inline child settled."),
		fauxAssistantMessage("The dormant successor accepted native editor input."),
	]);
	const childAgentId = await spawnRetainedChild(host);
	await executeAndCommitRegisteredTool(
		host.session,
		"agent_control",
		"terminate-before-named-inline-editor-input",
		{ operation: "terminate", agentId: childAgentId },
	);
	await selectDormantAgent(host, childAgentId);
	const dormantPresentation = host.runtime.session;
	const input = "Start this dormant Agent from the native editor.";

	await dormantPresentation.prompt(input);

	assert.notEqual(host.runtime.session, dormantPresentation);
	assert.equal(host.runtime.session.sessionId, childAgentId);
	await host.runtime.session.waitForIdle();
	assert.match(
		JSON.stringify(host.runtime.session.sessionManager.getEntries()),
		new RegExp(input),
	);
	assert.equal(
		host.ui.notifications.some(({ message }) => message.includes("Agent input failed")),
		false,
	);
	await host.runtime.dispose();
});

test("same-Agent selection repairs a degraded Dormant binding after selected Run failure", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, {
		persistent: true,
		settings: { retry: { enabled: false } },
	});
	let markGenerationStarted!: () => void;
	const generationStarted = new Promise<void>((resolve) => {
		markGenerationStarted = resolve;
	});
	let releaseFailure!: () => void;
	const failureGate = new Promise<void>((resolve) => {
		releaseFailure = resolve;
	});
	host.model.setResponses([
		async () => {
			markGenerationStarted();
			await failureGate;
			return fauxAssistantMessage("The selected exact Run fails terminally.", {
				stopReason: "error",
				errorMessage: "deterministic selected Run failure",
			});
		},
	]);
	const childAgentId = await spawnRetainedChild(host);
	await generationStarted;
	await selectAgent(host, childAgentId);
	const failedSession = host.runtime.session;
	let rebindBlocked = true;
	let rebindAttempts = 0;
	host.runtime.setRebindSession(async () => {
		rebindAttempts += 1;
		if (rebindBlocked) {
			throw new Error("deterministic failure-transition rebind failure");
		}
	});

	releaseFailure();
	await failedSession.waitForIdle();
	await waitForCondition(() => host.runtime.session !== failedSession);

	assert.equal(host.runtime.session.sessionId, childAgentId);
	assert.equal(
		await observeCurrentRunPhase(
			host,
			childAgentId,
			"observe-selected-agent-after-run-failure",
		),
		"dormant",
	);
	assert.match(
		host.runtime.diagnostics.at(-1)?.message ?? "",
		/Interactive Selection detached from an ending Run.*failure-transition rebind failure/,
	);
	const failedRepair = await openAgentsSurface(host);
	const failedRepairRendered = failedRepair.surface.render(80).join("\n");
	assert.match(failedRepairRendered, /Dormant Agents/);
	assert.match(failedRepairRendered, new RegExp(childAgentId));
	failedRepair.surface.handleInput?.("\r");
	await failedRepair.command;
	const attemptsBeforeRepair = rebindAttempts;
	rebindBlocked = false;
	const reselection = await openAgentsSurface(host);
	const reselectionRendered = reselection.surface.render(80).join("\n");
	assert.match(reselectionRendered, /Dormant Agents/);
	assert.match(reselectionRendered, new RegExp(childAgentId));
	reselection.surface.handleInput?.("\r");
	await reselection.command;
	assert.equal(rebindAttempts, attemptsBeforeRepair + 1);
	assert.notEqual(host.runtime.session, failedSession);
	const repairedSurface = await openAgentsSurface(host);
	repairedSurface.surface.handleInput?.("\x1b");
	await repairedSurface.command;
	const repairedPresentation = host.runtime.session;
	const repairedInput = "Native input after same-Agent binding repair.";
	host.model.setResponses([
		fauxAssistantMessage("The repaired presentation started one successor."),
	]);
	await repairedPresentation.prompt(repairedInput);

	assert.notEqual(host.runtime.session, repairedPresentation);
	assert.equal(
		JSON.stringify(host.runtime.session.sessionManager.getEntries()).split(repairedInput)
			.length - 1,
		1,
	);
	await bindTestOwnerHost(host, "tui");
	await host.runtime.dispose();
});

test("the named llama.cpp extension remains usable through child startup and shutdown on the shared ModelRuntime", async () => {
	const router = await startMockLlamaRouter();
	const previousBaseUrl = process.env.LLAMA_BASE_URL;
	const previousApiKey = process.env.LLAMA_API_KEY;
	process.env.LLAMA_BASE_URL = router.baseUrl;
	process.env.LLAMA_API_KEY = "local-conformance-key";
	hostPi.initTheme();
	const host = await createPiCliTestOwnerHost(piAgentCoordination, { persistent: true });
	try {
		const sharedModelRuntime = host.services.modelRuntime;
		assert.ok(sharedModelRuntime.getProvider("llama.cpp"));
		await refreshLlamaCatalogThroughCommand(host, host.session);
		await assertLlamaInference(sharedModelRuntime, "before child startup");
		host.model.setResponses([
			fauxAssistantMessage("Remain live while llama.cpp conformance is checked."),
		]);
		const childAgentId = await spawnRetainedChild(host);
		assert.ok(sharedModelRuntime.getModel("llama.cpp", LLAMA_MODEL_ID));
		await assertLlamaInference(sharedModelRuntime, "after child startup");

		await selectAgent(host, childAgentId);
		const child = host.runtime.session;
		assert.equal(host.runtime.services.modelRuntime, sharedModelRuntime);
		await refreshLlamaCatalogThroughCommand(host, child);
		await assertLlamaInference(sharedModelRuntime, "from the child Run");

		await selectAgent(host, host.session.sessionId);
		await assertLlamaInference(sharedModelRuntime, "from the Owner while the child is live");
		await executeAndCommitRegisteredTool(
			host.session,
			"agent_control",
			"terminate-llama-child",
			{
				operation: "terminate",
				agentId: childAgentId,
			},
		);
		assert.ok(sharedModelRuntime.getProvider("llama.cpp"));
		await assertLlamaInference(sharedModelRuntime, "after child shutdown");
	} finally {
		if (previousBaseUrl === undefined) delete process.env.LLAMA_BASE_URL;
		else process.env.LLAMA_BASE_URL = previousBaseUrl;
		if (previousApiKey === undefined) delete process.env.LLAMA_API_KEY;
		else process.env.LLAMA_API_KEY = previousApiKey;
		await host.runtime.dispose();
		await router.close();
	}
});

test("native long-to-short rebinding reconstructs the complete terminal viewport", async () => {
	installInteractiveHostBridge(hostPi);
	const researcherHost = await createUnboundTestOwnerHost(() => undefined);
	const ownerHost = await createUnboundTestOwnerHost(() => undefined);
	researcherHost.runtime.setBeforeSessionInvalidate(() => undefined);
	researcherHost.runtime.setRebindSession(async () => undefined);
	const terminal = new HeadlessTerminal();
	const tui = new TuiMainScreen(terminal);
	const visibleTranscript = new MutableTranscript(transcript("Researcher", 20));
	tui.addChild(visibleTranscript);
	tui.requestRender(true);
	await terminal.settle();
	const researcherSession = researcherHost.session;
	const ownerSession = ownerHost.session;
	const runtimeHost = researcherHost.runtime;
	const mode = Object.assign(Object.create(hostPi.InteractiveMode.prototype), {
		runtimeHost,
		ui: tui,
		applyRuntimeSettings() {},
		renderCurrentSessionState() {
			visibleTranscript.lines = runtimeHost.session === ownerSession
				? transcript("Owner", 14)
				: transcript("Researcher", 20);
			tui.requestRender();
		},
		createExtensionUIContext: () => researcherHost.ui,
		setupAutocompleteProvider() {},
		setupExtensionShortcuts() {},
		showLoadedResources() {},
		showStartupNoticesIfNeeded() {},
		showExtensionError() {},
		subscribeToAgent() {},
		async updateAvailableProviderCount() {},
		updateEditorBorderColor() {},
		updateTerminalTitle() {},
		clearStatusIndicator() {},
		setWorkingVisible() {},
	}) as InstanceType<typeof hostPi.InteractiveMode>;
	const rebindCurrentSession = (
		mode as unknown as {
			rebindCurrentSession(options: { renderBeforeBind: boolean }): Promise<void>;
		}
	).rebindCurrentSession.bind(mode);

	await rebindCurrentSession({ renderBeforeBind: true });
	const mutableRuntime = runtimeHost as unknown as {
		_session: typeof ownerSession;
		_services: typeof ownerHost.services;
	};
	mutableRuntime._session = ownerSession;
	mutableRuntime._services = ownerHost.services;
	await rebindCurrentSession({ renderBeforeBind: true });
	await terminal.settle();

	assert.equal(terminal.bottomViewportLine(), "Owner FOOTER");
	assert.equal(terminal.viewport().some((line) => line.includes("Researcher")), false);
	await researcherHost.runtime.dispose();
	researcherSession.dispose();
});

async function spawnRetainedChild(
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
): Promise<string> {
	const input = { request: "Remain live for native selection conformance." };
	const toolCallId = "spawn-native-selection-conformance-child";
	const result = await executeAndCommitRegisteredTool(
		host.session,
		"agent_spawn",
		toolCallId,
		input,
	);
	assert.equal((result.details as { disposition: string }).disposition, "pending");
	return (result.details as { agentId: string }).agentId;
}

async function observeCurrentRunPhase(
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
	agentId: string,
	toolCallId: string,
): Promise<string> {
	const session = host.session;
	const observe = session.getToolDefinition("agent_observe");
	assert.ok(observe);
	const status = await observe.execute(
		toolCallId,
		{ operation: "status", agentId },
		undefined,
		undefined,
		session.extensionRunner.createContext(),
	);
	return (status.details as { run: { phase: string } }).run.phase;
}

async function waitForRunAttention(
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
	agentId: string,
	attention: string,
): Promise<void> {
	for (let attempt = 0; attempt < 1_000; attempt += 1) {
		const observe = host.session.getToolDefinition("agent_observe");
		assert.ok(observe);
		const status = await observe.execute(
			`wait-for-attention-${attempt}`,
			{ operation: "status", agentId },
			undefined,
			undefined,
			host.session.extensionRunner.createContext(),
		);
		if ((status.details as { run: { attention?: string } }).run.attention === attention) {
			return;
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error(`Agent ${agentId} did not reach attention ${attention}`);
}

async function refreshLlamaCatalogThroughCommand(
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
	session: hostPi.AgentSession,
): Promise<void> {
	const prompt = session.prompt("/llama");
	await waitForCondition(() => host.ui.customSurfaces.length === 1);
	const surface = host.ui.customSurfaces[0];
	assert.ok(surface?.handleInput);
	try {
		await waitForCondition(() =>
			surface.render(120).some((line) => line.includes(LLAMA_MODEL_ID))
		);
	} catch {
		throw new Error(
			`llama.cpp catalog did not render:\n${surface.render(120).join("\n")}\n` +
			`notifications: ${JSON.stringify(host.ui.notifications)}`,
		);
	}
	surface.handleInput("\x1b");
	await prompt;
}

async function assertLlamaInference(
	modelRuntime: hostPi.ModelRuntime,
	prompt: string,
): Promise<void> {
	const model = modelRuntime.getModel("llama.cpp", LLAMA_MODEL_ID);
	assert.ok(model);
	const response = await modelRuntime.completeSimple(model, {
		messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
	});
	assert.equal(response.stopReason, "stop");
	assert.deepEqual(response.content, [{ type: "text", text: "llama conformance response" }]);
}

async function startMockLlamaRouter(): Promise<{
	baseUrl: string;
	close(): Promise<void>;
}> {
	let completionSequence = 0;
	const server = createServer((request, response) => {
		request.resume();
		if (request.url === "/models") {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({
				data: [{
					id: LLAMA_MODEL_ID,
					status: { value: "loaded" },
					meta: { n_ctx: 8_192 },
					architecture: { input_modalities: ["text"] },
				}],
			}));
			return;
		}
		if (request.url === "/v1/chat/completions") {
			completionSequence += 1;
			response.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			response.write(`data: ${JSON.stringify({
				id: `llama-conformance-${completionSequence}`,
				model: LLAMA_MODEL_ID,
				choices: [{
					index: 0,
					delta: { role: "assistant", content: "llama conformance response" },
					finish_reason: null,
				}],
			})}\n\n`);
			response.write(`data: ${JSON.stringify({
				id: `llama-conformance-${completionSequence}`,
				model: LLAMA_MODEL_ID,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			})}\n\n`);
			response.end("data: [DONE]\n\n");
			return;
		}
		response.writeHead(404).end();
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		close: () => new Promise<void>((resolve, reject) => {
			server.close((error) => error ? reject(error) : resolve());
		}),
	};
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 1_000; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("Expected conformance condition did not become true");
}

class MutableTranscript implements Component {
	lines: string[];
	constructor(lines: string[]) {
		this.lines = lines;
	}
	invalidate(): void {}
	render(): string[] {
		return this.lines;
	}
}

class HeadlessTerminal implements Terminal {
	readonly #xterm = new XtermTerminal({
		allowProposedApi: true,
		cols: TERMINAL_COLUMNS,
		rows: TERMINAL_ROWS,
		scrollback: 100,
	});
	#pendingWrites = Promise.resolve();

	get columns(): number {
		return TERMINAL_COLUMNS;
	}
	get rows(): number {
		return TERMINAL_ROWS;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	moveBy(): void {}
	write(data: string): void {
		this.#pendingWrites = this.#pendingWrites.then(
			() => new Promise<void>((resolve) => this.#xterm.write(data, resolve)),
		);
	}
	async settle(): Promise<void> {
		await new Promise<void>((resolve) => setImmediate(resolve));
		await new Promise<void>((resolve) => setImmediate(resolve));
		await this.#pendingWrites;
	}
	bottomViewportLine(): string {
		return this.viewport().at(-1) ?? "";
	}
	viewport(): string[] {
		this.#xterm.scrollToBottom();
		const buffer = this.#xterm.buffer.active;
		return Array.from({ length: TERMINAL_ROWS }, (_value, index) =>
			buffer
				.getLine(buffer.viewportY + index)
				?.translateToString(true)
				.trim() ?? "",
		);
	}
}

function transcript(agent: string, lineCount: number): string[] {
	const sharedHeader = Array.from(
		{ length: 10 },
		(_value, index) => `Shared Pi layout ${index + 1}`,
	);
	return [
		...sharedHeader,
		...Array.from(
			{ length: lineCount - sharedHeader.length - 1 },
			(_value, index) => `${agent} transcript ${index + 1}`,
		),
		`${agent} FOOTER`,
	];
}
