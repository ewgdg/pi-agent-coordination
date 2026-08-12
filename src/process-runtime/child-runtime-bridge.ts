import * as hostPi from "@earendil-works/pi-coding-agent";
import type {
	AgentSession,
	AgentSessionEvent,
	AgentSessionRuntime,
	ExtensionContext,
	ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { FramedAgentControlChannel } from "../control/agent-control-channel.ts";
import {
	agentControlProtocol,
	type RemoteAgentSelectorSnapshot,
} from "../control/agent-control-protocol.ts";
import { connectControlTransport } from "../control/control-platform.ts";
import {
	AGENT_CONTROL_PROTOCOL_VERSION,
	type ChildProcessBootstrap,
	validateChildProcessBootstrap,
} from "../control/control-protocol-schemas.ts";
import { installInteractiveHostBridge } from "../pi-integration/interactive-host-bridge.ts";
import {
	installAgentActivityDock,
	type AgentActivitySnapshot,
	type AgentActivitySource,
} from "../presentation/agent-activity-surface.ts";
import { continueFromCommittedInput } from "../pi-integration/committed-input.ts";
import {
	registerParticipantInputLifecycle,
	registerParticipantLifecycle,
} from "../pi-integration/participant-lifecycle.ts";
import { registerParticipantCoordinationTools } from "../tools/participant-coordination-tools.ts";
import type { AgentRuntimeDelivery } from "../runtime/agent-runtime-host.ts";
import { CHILD_PROCESS_BOOTSTRAP_ENVIRONMENT_VARIABLE } from "./child-process-environment.ts";
import {
	createControlBackedChildParticipantHandlers,
	createControlBackedChildPresentationHandlers,
	type ChildParticipantControlRequester,
} from "./remote-participant-control.ts";
import { registerRemoteAgentsCommand } from "./remote-agent-selector.ts";

const ENTRY_MODULE_PATH = import.meta.filename;
const CHILD_NATIVE_SESSION_REPLACEMENT_MESSAGE =
	"Return to Owner before replacing or forking the native session.";

type ChildChannel = FramedAgentControlChannel<typeof agentControlProtocol>;

type ChildRuntimeBinding = {
	context: ExtensionContext;
	runtime: AgentSessionRuntime;
	activity: RemoteAgentActivitySource;
	reinitializePresentation(): void;
	handleOwnerRequest(
		request: Parameters<Parameters<ChildChannel["onRequest"]>[0]>[0],
	): Promise<unknown>;
	handleOwnerEvent(event: Parameters<Parameters<ChildChannel["onEvent"]>[0]>[0]): void;
	handleControlClose(): void;
	dispose(): void;
};

type ChildControlState = {
	channel: ChildChannel;
	currentBinding?: ChildRuntimeBinding;
	currentRunId?: string;
	latestRunId?: string;
	currentRunOutcome: "completed" | "interrupted" | "failed";
	nativeRunSequence: number;
	queueIntentionTail: Promise<void>;
	shutdownStarted: boolean;
};

const CHILD_CONTROL_REGISTRY_KEY = "__piAgentCoordinationChildControls";
const globalChildControlRegistry = globalThis as typeof globalThis & {
	[CHILD_CONTROL_REGISTRY_KEY]?: WeakMap<AgentSession, ChildControlState>;
};
// Pi retains the exact AgentSession across /reload. Preserve only its authenticated
// Control and continuity state; every extension generation replaces currentBinding.
const childControls = (
	globalChildControlRegistry[CHILD_CONTROL_REGISTRY_KEY] ??= new WeakMap()
);

const childRuntimeBridge: ExtensionFactory = async (pi) => {
	const bootstrap = await readBootstrapDescriptor();
	const interactiveBridge = installInteractiveHostBridge(hostPi);
	let state: ChildControlState | undefined;
	const participantRequest: ChildParticipantControlRequester = (method, payload, signal) => {
		if (!state) throw new Error("child_runtime_control_unavailable: Runtime is not connected");
		return state.channel.request(method, payload, signal);
	};
	registerRemoteAgentsCommand(
		pi,
		createControlBackedChildPresentationHandlers(participantRequest),
	);
	let registerParticipantInput: () => void;
	if (bootstrap.role === "ordinary") {
		const handlers = createControlBackedChildParticipantHandlers("ordinary", participantRequest);
		registerParticipantLifecycle(pi, handlers.lifecycle, { registerInput: false });
		registerParticipantCoordinationTools(pi, "ordinary", handlers.coordination);
		registerParticipantInput = () => registerParticipantInputLifecycle(pi, handlers.lifecycle);
	} else {
		const handlers = createControlBackedChildParticipantHandlers("moderator", participantRequest);
		registerParticipantLifecycle(pi, handlers.lifecycle, { registerInput: false });
		registerParticipantCoordinationTools(pi, "moderator", handlers.coordination);
		registerParticipantInput = () => registerParticipantInputLifecycle(pi, handlers.lifecycle);
	}
	pi.on("session_before_fork", (_event, ctx) => cancelNativeSessionReplacement(ctx));
	pi.on("session_before_switch", (_event, ctx) => cancelNativeSessionReplacement(ctx));

	pi.on("session_start", async (event, ctx) => {
		if (state) throw new Error("child_runtime_bridge_rebound: session replacement is not supported");
		if (ctx.mode !== "tui" || !ctx.hasUI) {
			throw new Error("child_runtime_bridge_requires_tui: expected mode=tui and hasUI=true");
		}
		const capture = await interactiveBridge.capture(ctx.sessionManager as hostPi.SessionManager);
		assertExpectedSession(capture.runtime, bootstrap);
		const retained = childControls.get(capture.runtime.session);
		if (retained && event.reason !== "reload") {
			throw new Error("child_runtime_bridge_rebound: session replacement is not supported");
		}
		if (retained) {
			state = retained;
		} else {
			const transport = await connectControlTransport(bootstrap.endpoint);
			const channel = new FramedAgentControlChannel({
				identity: {
					protocolVersion: AGENT_CONTROL_PROTOCOL_VERSION,
					workflowId: bootstrap.workflowId,
					agentId: bootstrap.agentId,
				},
				protocol: agentControlProtocol,
				transport,
			});
			state = {
				channel,
				currentRunOutcome: "completed",
				nativeRunSequence: 0,
				queueIntentionTail: Promise.resolve(),
				shutdownStarted: false,
			};
			childControls.set(capture.runtime.session, state);
			channel.onRequest((request) => requireCurrentBinding(state as ChildControlState)
				.handleOwnerRequest(request));
			channel.onEvent((event) => requireCurrentBinding(state as ChildControlState)
				.handleOwnerEvent(event));
			channel.onClose(() => state?.currentBinding?.handleControlClose());
		}
		const currentState = state;
		currentState.currentBinding?.dispose();
		const binding = createChildRuntimeBinding(
			currentState,
			capture.runtime,
			ctx,
			capture.reinitializePresentation,
			bootstrap.agentId,
		);
		currentState.currentBinding = binding;
		currentState.shutdownStarted = false;
		// Inherited input preflights must run before coordination consumes an exact
		// interactive submission, while the other lifecycle and tools must exist
		// before inherited session_start hooks can initiate work.
		registerParticipantInput();
		const channel = currentState.channel;
		try {
			assertExpectedSession(binding.runtime, bootstrap);
			if (!retained) {
				await channel.sendHello({
					connectionToken: bootstrap.connectionToken,
					expectedSessionId: bootstrap.expectedSessionId,
				});
			}
			if (bootstrap.ownerPresentation) {
				binding.activity.update(
					await participantRequest("presentation.agents.snapshot", {}),
				);
				installAgentActivityDock(ctx.ui, binding.activity);
			}
			if (retained) return;
			await channel.sendEvent("runtime.ready", {
				sessionId: ctx.sessionManager.getSessionId(),
				mode: "tui",
				hasUI: true,
			});
		} catch (error) {
			await reportFault(channel, "runtime_startup_failed", error);
			await channel.close().catch(() => undefined);
			throw error;
		}
	});

	pi.on("session_shutdown", async (event) => {
		const current = state;
		if (!current) return;
		// Reload invalidates this extension runner but retains the exact AgentSession
		// and process. The fresh session_start evaluation rebinds the same channel.
		if (event.reason !== "reload") current.shutdownStarted = true;
		await current.channel.sendEvent("session.shutdown", { reason: event.reason })
			.catch(() => undefined);
	});
};

function createChildRuntimeBinding(
	state: ChildControlState,
	runtime: AgentSessionRuntime,
	context: ExtensionContext,
	reinitializePresentation: () => void,
	agentId: string,
): ChildRuntimeBinding {
	let binding!: ChildRuntimeBinding;
	const activity = new RemoteAgentActivitySource(agentId);
	const removeLifecycleSubscription = runtime.session.subscribe((event) => {
		void reportRuntimeLifecycle(state, runtime, activity, event).catch((error: unknown) =>
			reportFault(state.channel, "runtime_lifecycle_failed", error)
		);
	});
	binding = {
		context,
		runtime,
		activity,
		reinitializePresentation,
		handleOwnerRequest: (request) => handleOwnerRequest(state, binding, request),
		handleOwnerEvent(event) {
			if (event.event === "presentation.agents.changed") {
				binding.activity.update(event.payload);
			}
		},
		handleControlClose() {
			if (state.shutdownStarted) return;
			state.shutdownStarted = true;
			context.shutdown();
		},
		dispose: removeLifecycleSubscription,
	};
	return binding;
}

function requireCurrentBinding(state: ChildControlState): ChildRuntimeBinding {
	if (!state.currentBinding) {
		throw new Error("child_runtime_control_unavailable: Runtime binding is unavailable");
	}
	return state.currentBinding;
}

async function handleOwnerRequest(
	state: ChildControlState,
	binding: ChildRuntimeBinding,
	request: Parameters<Parameters<ChildChannel["onRequest"]>[0]>[0],
): Promise<unknown> {
	switch (request.method) {
		case "runtime.snapshot":
			return runtimeSnapshot(binding.runtime, binding.context);
		case "run.prompt": {
			if (state.currentRunId) {
				throw new Error(`child_runtime_busy: run ${state.currentRunId} is still admitted`);
			}
			state.currentRunId = request.payload.runId;
			state.latestRunId = request.payload.runId;
			state.currentRunOutcome = "completed";
			let resolvePreflight!: (accepted: boolean) => void;
			const preflight = new Promise<boolean>((resolve) => {
				resolvePreflight = resolve;
			});
			void binding.runtime.session.prompt(request.payload.input, {
				source: "extension",
				preflightResult: resolvePreflight,
			}).catch(async (error: unknown) => {
				await failCurrentRun(
					state,
					binding.runtime,
					binding.activity,
					request.payload.runId,
					error,
				);
			});
			const accepted = await preflight;
			if (!accepted && state.currentRunId === request.payload.runId) {
				state.currentRunId = undefined;
			}
			return { accepted };
		}
		case "message.deliver": {
			admitRun(state, request.payload.runId);
			const wasActive = !binding.runtime.session.isIdle;
			const commit = observeDeliveryCommit(
				binding.runtime,
				binding.context.sessionManager,
				request.payload.delivery,
			);
			const completion = wasActive
				? sequenceQueueIntention(state, () => {
					if (request.signal.aborted) throw requestCancellationError(request.signal);
					return dispatchDelivery(binding.runtime, request.payload.delivery);
				})
				: dispatchDelivery(binding.runtime, request.payload.delivery);
			const cancel = () => {
				commit.reject(requestCancellationError(request.signal));
				if (state.currentRunId !== request.payload.runId) return;
				binding.runtime.session.clearQueue();
				void binding.runtime.session.abort().catch((error: unknown) =>
					reportFault(state.channel, "run_cancellation_failed", error)
				);
			};
			if (request.signal.aborted) cancel();
			else request.signal.addEventListener("abort", cancel, { once: true });
			if (!wasActive) {
				void completion.then(
					() => queueMicrotask(() => commit.settle(false)),
					(error: unknown) => commit.reject(error),
				);
			}
			void completion.catch(async (error: unknown) => {
				commit.reject(error);
				await failCurrentRun(
					state,
					binding.runtime,
					binding.activity,
					request.payload.runId,
					error,
				);
			});
			try {
				const transcriptCommitted = await commit.result;
				const modelCycleStarted = wasActive || !binding.runtime.session.isIdle;
				if (
					!modelCycleStarted &&
					state.currentRunId === request.payload.runId
				) state.currentRunId = undefined;
				return {
					accepted: true,
					transcriptCommitted,
					modelCycleStarted,
					queuedInputCount: binding.runtime.session.pendingMessageCount,
				};
			} finally {
				request.signal.removeEventListener("abort", cancel);
			}
		}
		case "run.continue": {
			if (request.signal.aborted) throw requestCancellationError(request.signal);
			if (state.currentRunId) {
				throw new Error(`child_runtime_busy: run ${state.currentRunId} is still admitted`);
			}
			state.currentRunId = request.payload.runId;
			state.latestRunId = request.payload.runId;
			state.currentRunOutcome = "completed";
			// The Control response owns dispatch acceptance only. Exact completion and
			// cancellation remain the agent lifecycle events and run.interrupt request;
			// no long-running request is left pretending to own the model cycle.
			void continueFromCommittedInput(binding.runtime.session).catch((error: unknown) =>
				failCurrentRun(
					state,
					binding.runtime,
					binding.activity,
					request.payload.runId,
					error,
				)
			);
			return { accepted: true };
		}
		case "queue.clear": {
			requireCurrentOrLatestRun(state, request.payload.runId);
			const cleared = await sequenceQueueIntention(
				state,
				() => binding.runtime.session.clearQueue(),
			);
			return {
				...cleared,
				queuedInputCount: binding.runtime.session.pendingMessageCount,
			};
		}
		case "run.interrupt": {
			const accepted = requireCurrentOrLatestRun(state, request.payload.runId);
			if (accepted) {
				await sequenceQueueIntention(state, () => binding.runtime.session.abort());
			}
			return { accepted };
		}
		case "presentation.reinitialize":
			binding.reinitializePresentation();
			return {};
		case "runtime.shutdown":
			state.shutdownStarted = true;
			setImmediate(() => binding.context.shutdown());
			return { accepted: true };
		case "runtime.executionBegin":
		case "runtime.humanInput":
		case "runtime.humanInputMode":
		case "runtime.guardHumanToolResult":
		case "runtime.toolExecutionStart":
		case "runtime.safeBoundary":
		case "runtime.executionEnd":
		case "coordination.observe":
		case "coordination.message":
		case "coordination.control":
		case "coordination.spawn":
		case "coordination.askHuman":
		case "coordination.moderatorControl":
		case "presentation.agents.snapshot":
		case "presentation.agents.select":
			throw new Error(`child_runtime_direction_violation: ${request.method}`);
		default:
			return assertUnreachable(request);
	}
}

async function runtimeSnapshot(
	runtime: AgentSessionRuntime,
	context: ExtensionContext,
) {
	const session = runtime.session;
	const bridgePath = await canonicalFilePath(ENTRY_MODULE_PATH, runtime.cwd);
	const extensions = await Promise.all(
		runtime.services.resourceLoader.getExtensions().extensions
			.map((extension) => extension.resolvedPath)
			.filter((path) => !path.startsWith("<inline:"))
			.map((path) => canonicalFilePath(path, runtime.cwd)),
	);
	const appendPrompt = runtime.services.resourceLoader.getAppendSystemPrompt();
	const appendSources = runtime.services.resourceLoader.getAppendSystemPromptSources();
	if (appendPrompt.length !== appendSources.length || appendPrompt.length > 1) {
		throw new Error("child_runtime_project_context_mismatch: expected at most one file-backed append prompt");
	}
	const sessionPath = context.sessionManager.getSessionFile();
	if (!sessionPath) throw new Error("child_runtime_session_path_unavailable");
	const tools = session.getActiveToolNames();
	const toolExecutionModes = tools.map((name) => {
		const definition = session.getToolDefinition(name);
		if (!definition) {
			throw new Error(`child_runtime_tool_definition_unavailable: ${name}`);
		}
		return { name, executionMode: definition.executionMode ?? "parallel" };
	});
	const skillSources = await Promise.all(
		runtime.services.resourceLoader.getSkills().skills.map(async ({ name, filePath }) => ({
			name,
			filePath: await canonicalFilePath(filePath, runtime.cwd),
		})),
	);
	return {
		cwd: runtime.cwd,
		model: requireModel(session.model),
		thinking: session.thinkingLevel,
		tools,
		skills: skillSources.map(({ name }) => name),
		skillSources,
		extensions: extensions.filter((path) => path !== bridgePath),
		toolExecutionModes,
		projectTrusted: runtime.services.settingsManager.isProjectTrusted(),
		sessionId: session.sessionId,
		sessionPath,
		projectContext: appendPrompt.length === 0
			? null
			: {
				filePath: await canonicalFilePath(appendSources[0]!.path, runtime.cwd),
				body: appendPrompt[0]!,
			},
	};
}

async function reportRuntimeLifecycle(
	state: ChildControlState,
	runtime: AgentSessionRuntime,
	activity: RemoteAgentActivitySource,
	event: AgentSessionEvent,
): Promise<void> {
	if (event.type === "agent_start") {
		activity.setScopeFailed(false);
		// Interactive and extension-local Pi input is admitted through the child →
		// Owner lifecycle request before this awaited event. It has no Owner-issued
		// run.prompt request from which to inherit a transport cycle identity.
		state.currentRunId ??= `native-run-${++state.nativeRunSequence}`;
		state.latestRunId = state.currentRunId;
		await state.channel.sendEvent("agent.start", {
			runId: state.currentRunId,
			queuedInputCount: runtime.session.pendingMessageCount,
		});
		return;
	}
	if (event.type === "agent_end") {
		if (!state.currentRunId) return;
		const assistant = [...event.messages]
			.reverse()
			.find((message) => message.role === "assistant");
		state.currentRunOutcome = assistant?.role === "assistant" && assistant.stopReason === "aborted"
			? "interrupted"
			: assistant?.role === "assistant" && assistant.stopReason === "error"
				? "failed"
				: "completed";
		activity.setScopeFailed(state.currentRunOutcome === "failed");
		await state.channel.sendEvent("agent.end", {
			runId: state.currentRunId,
			outcome: state.currentRunOutcome,
			willRetry: event.willRetry,
			queuedInputCount: runtime.session.pendingMessageCount,
			...(assistant?.role === "assistant" && assistant.errorMessage
				? { error: assistant.errorMessage }
				: {}),
		});
		return;
	}
	if (event.type !== "agent_settled" || !state.currentRunId) return;
	const runId = state.currentRunId;
	await state.channel.sendEvent("agent.settled", {
		runId,
		outcome: state.currentRunOutcome,
		queuedInputCount: runtime.session.pendingMessageCount,
	});
	if (state.currentRunId === runId) state.currentRunId = undefined;
}

function admitRun(state: ChildControlState, runId: string): void {
	if (state.currentRunId && state.currentRunId !== runId) {
		throw new Error(`child_runtime_busy: run ${state.currentRunId} is still admitted`);
	}
	if (state.currentRunId) return;
	state.currentRunId = runId;
	state.latestRunId = runId;
	state.currentRunOutcome = "completed";
}

function requireCurrentOrLatestRun(state: ChildControlState, runId: string): boolean {
	const expectedRunId = state.currentRunId ?? state.latestRunId;
	if (runId !== expectedRunId) {
		throw new Error(
			`stale_run: ${runId} does not target the current or latest child Run`,
		);
	}
	return state.currentRunId === runId;
}

function sequenceQueueIntention<T>(
	state: ChildControlState,
	operation: () => T | Promise<T>,
): Promise<T> {
	const result = state.queueIntentionTail.then(operation);
	state.queueIntentionTail = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

function dispatchDelivery(
	runtime: AgentSessionRuntime,
	delivery: AgentRuntimeDelivery,
): Promise<void> {
	return delivery.kind === "custom"
		? runtime.session.sendCustomMessage(delivery.message, {
			triggerTurn: delivery.triggerTurn,
			...(delivery.deliverAs === undefined ? {} : { deliverAs: delivery.deliverAs }),
		})
		: runtime.session.sendUserMessage(
			typeof delivery.content === "string" ? delivery.content : [...delivery.content],
			{
				...(delivery.deliverAs === undefined ? {} : { deliverAs: delivery.deliverAs }),
			},
		);
}

function observeDeliveryCommit(
	runtime: AgentSessionRuntime,
	sessionManager: ExtensionContext["sessionManager"],
	delivery: AgentRuntimeDelivery,
): Readonly<{
	result: Promise<boolean>;
	settle(committed: boolean): void;
	reject(error: unknown): void;
}> {
	let settleResult!: (committed: boolean) => void;
	let rejectResult!: (error: unknown) => void;
	let settled = false;
	let unsubscribe: () => void = () => undefined;
	const existingEntryIds = new Set(
		sessionManager.getEntries().map((entry) => entry.id),
	);
	const finish = (settlement: () => void) => {
		if (settled) return;
		settled = true;
		unsubscribe();
		settlement();
	};
	const result = new Promise<boolean>((resolve, reject) => {
		settleResult = resolve;
		rejectResult = reject;
	});
	unsubscribe = runtime.session.subscribe((event) => {
		if (
			event.type === "message_end" &&
			matchesDeliveryMessage(delivery, event.message)
		) {
			// AgentSession notifies listeners immediately before its synchronous
			// SessionManager append. Verify the writer's new exact entry after that edge;
			// the lifecycle event alone is not durable transcript evidence.
			queueMicrotask(() => finish(() => settleResult(
				sessionManager.getEntries().some((entry) =>
					!existingEntryIds.has(entry.id) && matchesDeliveryEntry(delivery, entry)
				),
			)));
		}
		if (event.type === "agent_settled") finish(() => settleResult(false));
	});
	return {
		result,
		settle: (committed) => finish(() => settleResult(committed)),
		reject: (error) => finish(() => rejectResult(error)),
	};
}

function matchesDeliveryEntry(
	delivery: AgentRuntimeDelivery,
	entry: ReturnType<ExtensionContext["sessionManager"]["getEntries"]>[number],
): boolean {
	if (delivery.kind === "custom") {
		return entry.type === "custom_message" &&
			entry.customType === delivery.message.customType &&
			isDeepStrictEqual(entry.content, delivery.message.content) &&
			entry.display === delivery.message.display &&
			isDeepStrictEqual(entry.details, delivery.message.details);
	}
	return entry.type === "message" && matchesDeliveryMessage(delivery, entry.message);
}

function matchesDeliveryMessage(
	delivery: AgentRuntimeDelivery,
	message: unknown,
): boolean {
	if (!message || typeof message !== "object" || !("role" in message)) return false;
	if (delivery.kind === "custom") {
		return message.role === "custom" &&
			"customType" in message && message.customType === delivery.message.customType &&
			"content" in message && isDeepStrictEqual(message.content, delivery.message.content) &&
			"display" in message && message.display === delivery.message.display &&
			"details" in message && isDeepStrictEqual(message.details, delivery.message.details);
	}
	if (message.role !== "user" || !("content" in message)) return false;
	const content = typeof delivery.content === "string"
		? [{ type: "text", text: delivery.content }]
		: normalizeUserContent(delivery.content);
	return isDeepStrictEqual(message.content, content);
}

function normalizeUserContent(
	content: Extract<AgentRuntimeDelivery, { kind: "user" }>["content"] & readonly unknown[],
): readonly unknown[] {
	const text = content
		.filter((part): part is Extract<(typeof content)[number], { type: "text" }> =>
			typeof part === "object" && part !== null && "type" in part && part.type === "text"
		)
		.map((part) => part.text)
		.join("\n");
	const images = content.filter((part) =>
		typeof part === "object" && part !== null && "type" in part && part.type === "image"
	);
	return [{ type: "text", text }, ...images];
}

function requireModel(model: AgentSessionRuntime["session"]["model"]) {
	if (!model) throw new Error("child_runtime_model_unavailable: no active model");
	return { provider: model.provider, modelId: model.id };
}

async function canonicalFilePath(path: string, cwd: string): Promise<string> {
	return realpath(isAbsolute(path) ? path : resolve(cwd, path));
}

function cancelNativeSessionReplacement(
	ctx: ExtensionContext,
): { cancel: true } {
	ctx.ui.notify(CHILD_NATIVE_SESSION_REPLACEMENT_MESSAGE, "error");
	return { cancel: true };
}

async function failCurrentRun(
	state: ChildControlState,
	runtime: AgentSessionRuntime,
	activity: RemoteAgentActivitySource,
	runId: string,
	error: unknown,
): Promise<void> {
	activity.setScopeFailed(true);
	await reportFault(state.channel, "run_prompt_failed", error);
	if (state.currentRunId !== runId) return;
	await state.channel.sendEvent("agent.end", {
		runId,
		outcome: "failed",
		willRetry: false,
		queuedInputCount: runtime.session.pendingMessageCount,
		error: errorMessage(error),
	}).catch(() => undefined);
	await state.channel.sendEvent("agent.settled", {
		runId,
		outcome: "failed",
		queuedInputCount: runtime.session.pendingMessageCount,
	})
		.catch(() => undefined);
	if (state.currentRunId === runId) state.currentRunId = undefined;
}

async function reportFault(channel: ChildChannel, code: string, error: unknown): Promise<void> {
	await channel.sendEvent("runtime.fault", { code, message: errorMessage(error) })
		.catch(() => undefined);
}

function assertExpectedSession(runtime: AgentSessionRuntime, bootstrap: ChildProcessBootstrap): void {
	if (runtime.session.sessionId !== bootstrap.expectedSessionId) {
		throw new Error(
			`child_runtime_session_mismatch: expected ${bootstrap.expectedSessionId}, received ${runtime.session.sessionId}`,
		);
	}
}

class RemoteAgentActivitySource implements AgentActivitySource {
	#agentId: string;
	readonly #handlers = new Set<() => void>();
	#selector: RemoteAgentSelectorSnapshot | undefined;
	#scopeFailed = false;

	constructor(agentId: string) {
		this.#agentId = agentId;
	}

	update(selector: RemoteAgentSelectorSnapshot): void {
		this.#agentId = selector.selectedAgentId;
		this.#selector = selector;
		this.#notifyChanged();
	}

	setScopeFailed(failed: boolean): void {
		if (this.#scopeFailed === failed) return;
		this.#scopeFailed = failed;
		this.#notifyChanged();
	}

	snapshot(): AgentActivitySnapshot {
		const selector = this.#selector;
		if (!selector) {
			throw new Error("child_runtime_activity_unavailable: selector snapshot is not initialized");
		}
		const roster = [...selector.live, ...selector.dormant];
		const scope = roster.find(({ agentId }) => agentId === this.#agentId);
		if (!scope) {
			throw new Error(`child_runtime_activity_unavailable: Agent ${this.#agentId} is absent`);
		}
		return {
			scope: { ...scope, failed: this.#scopeFailed },
			children: selector.live
				.filter(({ directSpawnerAgentId }) => directSpawnerAgentId === this.#agentId)
				.map((child) => ({ ...child, failed: false })),
			answerMode: selector.humanAttention.some(({ agentId }) => agentId === this.#agentId),
			humanAttention: selector.humanAttention,
			operationalAttention: selector.operationalAttention,
		};
	}

	addChangeHandler(handler: () => void): () => void {
		this.#handlers.add(handler);
		return () => this.#handlers.delete(handler);
	}

	#notifyChanged(): void {
		for (const handler of this.#handlers) handler();
	}
}

async function readBootstrapDescriptor(): Promise<ChildProcessBootstrap> {
	const path = process.env[CHILD_PROCESS_BOOTSTRAP_ENVIRONMENT_VARIABLE];
	if (!path || !isAbsolute(path) || path.includes("\0")) {
		throw new Error("control_bootstrap_invalid: descriptor path must be absolute");
	}
	const descriptorStats = await stat(path);
	if (!descriptorStats.isFile()) {
		throw new Error("control_bootstrap_invalid: descriptor path is not a regular file");
	}
	if ((descriptorStats.mode & 0o077) !== 0) {
		throw new Error("control_bootstrap_invalid: descriptor must be owner-only");
	}
	let value: unknown;
	try {
		value = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		throw new Error(`control_bootstrap_invalid: ${errorMessage(error)}`);
	}
	return validateChildProcessBootstrap(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function requestCancellationError(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("The Control request was cancelled", "AbortError");
}

function assertUnreachable(value: never): never {
	throw new Error(`child_runtime_method_unavailable: ${String(value)}`);
}

export default childRuntimeBridge;
