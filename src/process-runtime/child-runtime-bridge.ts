import * as hostPi from "@earendil-works/pi-coding-agent";
import type {
	AgentSessionEvent,
	AgentSessionRuntime,
	ExtensionContext,
	ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { FramedAgentControlChannel } from "../control/agent-control-channel.ts";
import { agentControlProtocol } from "../control/agent-control-protocol.ts";
import { connectControlTransport } from "../control/control-platform.ts";
import {
	AGENT_CONTROL_PROTOCOL_VERSION,
	type ChildProcessBootstrap,
	validateChildProcessBootstrap,
} from "../control/control-protocol-schemas.ts";
import { installInteractiveHostBridge } from "../pi-integration/interactive-host-bridge.ts";
import { continueFromCommittedInput } from "../pi-integration/committed-input.ts";
import type { AgentRuntimeDelivery } from "../runtime/agent-runtime-host.ts";
import { CHILD_PROCESS_BOOTSTRAP_ENVIRONMENT_VARIABLE } from "./child-process-environment.ts";

const ENTRY_MODULE_PATH = import.meta.filename;

type ChildChannel = FramedAgentControlChannel<typeof agentControlProtocol>;

type RuntimeState = {
	channel: ChildChannel;
	context: ExtensionContext;
	runtime: AgentSessionRuntime;
	currentRunId?: string;
	latestRunId?: string;
	currentRunOutcome: "completed" | "interrupted" | "failed";
	queueIntentionTail: Promise<void>;
	shutdownStarted: boolean;
};

const childRuntimeBridge: ExtensionFactory = async (pi) => {
	const bootstrap = await readBootstrapDescriptor();
	const interactiveBridge = installInteractiveHostBridge(hostPi);
	let state: RuntimeState | undefined;

	pi.on("session_start", async (_event, ctx) => {
		if (state) throw new Error("child_runtime_bridge_rebound: session replacement is not supported");
		if (ctx.mode !== "tui" || !ctx.hasUI) {
			throw new Error("child_runtime_bridge_requires_tui: expected mode=tui and hasUI=true");
		}
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
		const capture = await interactiveBridge.capture(ctx.sessionManager as hostPi.SessionManager);
		state = {
			channel,
			context: ctx,
			runtime: capture.runtime,
			currentRunOutcome: "completed",
			queueIntentionTail: Promise.resolve(),
			shutdownStarted: false,
		};
		capture.runtime.session.subscribe((event) => {
			const current = state;
			if (!current) return;
			void reportRuntimeLifecycle(current, event).catch((error: unknown) =>
				reportFault(current.channel, "runtime_lifecycle_failed", error)
			);
		});
		channel.onRequest((request) => handleOwnerRequest(state as RuntimeState, request));
		channel.onEvent(() => undefined);
		channel.onClose(() => {
			const current = state;
			if (!current || current.shutdownStarted) return;
			current.shutdownStarted = true;
			current.context.shutdown();
		});
		try {
			assertExpectedSession(state.runtime, bootstrap);
			await channel.sendHello({
				connectionToken: bootstrap.connectionToken,
				expectedSessionId: bootstrap.expectedSessionId,
			});
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
		current.shutdownStarted = true;
		await current.channel.sendEvent("session.shutdown", { reason: event.reason })
			.catch(() => undefined);
	});
};

async function handleOwnerRequest(
	state: RuntimeState,
	request: Parameters<Parameters<ChildChannel["onRequest"]>[0]>[0],
): Promise<unknown> {
	switch (request.method) {
		case "runtime.snapshot":
			return runtimeSnapshot(state.runtime);
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
			void state.runtime.session.prompt(request.payload.input, {
				source: "extension",
				preflightResult: resolvePreflight,
			}).catch(async (error: unknown) => {
				await failCurrentRun(state, request.payload.runId, error);
			});
			const accepted = await preflight;
			if (!accepted && state.currentRunId === request.payload.runId) {
				state.currentRunId = undefined;
			}
			return { accepted };
		}
		case "message.deliver": {
			admitRun(state, request.payload.runId);
			const wasActive = !state.runtime.session.isIdle;
			const commit = observeDeliveryCommit(
				state.runtime,
				state.context.sessionManager,
				request.payload.delivery,
			);
			const completion = wasActive
				? sequenceQueueIntention(state, () => {
					if (request.signal.aborted) throw requestCancellationError(request.signal);
					return dispatchDelivery(state.runtime, request.payload.delivery);
				})
				: dispatchDelivery(state.runtime, request.payload.delivery);
			const cancel = () => {
				commit.reject(requestCancellationError(request.signal));
				if (state.currentRunId !== request.payload.runId) return;
				state.runtime.session.clearQueue();
				void state.runtime.session.abort().catch((error: unknown) =>
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
				await failCurrentRun(state, request.payload.runId, error);
			});
			try {
				const transcriptCommitted = await commit.result;
				const modelCycleStarted = wasActive || !state.runtime.session.isIdle;
				if (
					!modelCycleStarted &&
					state.currentRunId === request.payload.runId
				) state.currentRunId = undefined;
				return {
					accepted: true,
					transcriptCommitted,
					modelCycleStarted,
					queuedInputCount: state.runtime.session.pendingMessageCount,
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
			void continueFromCommittedInput(state.runtime.session).catch((error: unknown) =>
				failCurrentRun(state, request.payload.runId, error)
			);
			return { accepted: true };
		}
		case "queue.clear": {
			requireCurrentOrLatestRun(state, request.payload.runId);
			const cleared = await sequenceQueueIntention(
				state,
				() => state.runtime.session.clearQueue(),
			);
			return {
				...cleared,
				queuedInputCount: state.runtime.session.pendingMessageCount,
			};
		}
		case "run.interrupt": {
			const accepted = requireCurrentOrLatestRun(state, request.payload.runId);
			if (accepted) {
				await sequenceQueueIntention(state, () => state.runtime.session.abort());
			}
			return { accepted };
		}
		case "runtime.shutdown":
			state.shutdownStarted = true;
			setImmediate(() => state.context.shutdown());
			return { accepted: true };
		default:
			return assertUnreachable(request);
	}
}

function runtimeSnapshot(runtime: AgentSessionRuntime) {
	const session = runtime.session;
	const bridgePath = canonicalExtensionPath(ENTRY_MODULE_PATH);
	return {
		cwd: runtime.cwd,
		model: requireModel(session.model),
		thinking: session.thinkingLevel,
		tools: session.getActiveToolNames(),
		skills: runtime.services.resourceLoader.getSkills().skills.map(({ name }) => name),
		extensions: runtime.services.resourceLoader.getExtensions().extensions
			.map((extension) => extension.resolvedPath)
			.filter((path) => !path.startsWith("<inline:") && canonicalExtensionPath(path) !== bridgePath),
		projectTrusted: runtime.services.settingsManager.isProjectTrusted(),
		sessionId: session.sessionId,
	};
}

async function reportRuntimeLifecycle(
	state: RuntimeState,
	event: AgentSessionEvent,
): Promise<void> {
	if (event.type === "agent_start") {
		if (!state.currentRunId) {
			await reportFault(
				state.channel,
				"run_identity_missing",
				new Error("Pi started without an admitted run"),
			);
			return;
		}
		await state.channel.sendEvent("agent.start", {
			runId: state.currentRunId,
			queuedInputCount: state.runtime.session.pendingMessageCount,
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
		await state.channel.sendEvent("agent.end", {
			runId: state.currentRunId,
			outcome: state.currentRunOutcome,
			willRetry: event.willRetry,
			queuedInputCount: state.runtime.session.pendingMessageCount,
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
		queuedInputCount: state.runtime.session.pendingMessageCount,
	});
	if (state.currentRunId === runId) state.currentRunId = undefined;
}

function admitRun(state: RuntimeState, runId: string): void {
	if (state.currentRunId && state.currentRunId !== runId) {
		throw new Error(`child_runtime_busy: run ${state.currentRunId} is still admitted`);
	}
	if (state.currentRunId) return;
	state.currentRunId = runId;
	state.latestRunId = runId;
	state.currentRunOutcome = "completed";
}

function requireCurrentOrLatestRun(state: RuntimeState, runId: string): boolean {
	const expectedRunId = state.currentRunId ?? state.latestRunId;
	if (runId !== expectedRunId) {
		throw new Error(
			`stale_run: ${runId} does not target the current or latest child Run`,
		);
	}
	return state.currentRunId === runId;
}

function sequenceQueueIntention<T>(
	state: RuntimeState,
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

function canonicalExtensionPath(path: string): string {
	return isAbsolute(path) ? path : new URL(path, import.meta.url).pathname;
}

async function failCurrentRun(state: RuntimeState, runId: string, error: unknown): Promise<void> {
	await reportFault(state.channel, "run_prompt_failed", error);
	if (state.currentRunId !== runId) return;
	await state.channel.sendEvent("agent.end", {
		runId,
		outcome: "failed",
		willRetry: false,
		queuedInputCount: state.runtime.session.pendingMessageCount,
		error: errorMessage(error),
	}).catch(() => undefined);
	await state.channel.sendEvent("agent.settled", {
		runId,
		outcome: "failed",
		queuedInputCount: state.runtime.session.pendingMessageCount,
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
