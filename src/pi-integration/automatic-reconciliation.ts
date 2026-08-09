import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEvent,
	type Api,
	type Model,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

const OPENAI_CODEX_RESPONSES_API = "openai-codex-responses";

export type AgentGenerationHandle = Readonly<{
	readonly run: object;
	readonly sequence: number;
}>;

export type AutomaticReconciliationRejection =
	| "ambiguous_connection_loss"
	| "regenerated_prompt"
	| "malformed_tool_call"
	| "context_limit"
	| "authentication"
	| "policy"
	| "quota"
	| "invalid_request"
	| "uncertain_external_effect"
	| "exhausted"
	| "indeterminate"
	| "unavailable";

export type AutomaticGenerationReconciliationDecision =
	| Readonly<{
		kind: "continued";
		generation: AgentGenerationHandle;
		recipe: "confirmed_truncation" | "provider_native_stream_resumption";
		message: AssistantMessage;
	}>
	| Readonly<{
		kind: "rejected";
		reason: AutomaticReconciliationRejection;
	}>;

export type AutomaticGenerationReconciliationAdapter = Readonly<{
	continueGeneration(input: Readonly<{
		generation: AgentGenerationHandle;
		failure: AssistantMessage & { stopReason: "error" };
	}>): Promise<AutomaticGenerationReconciliationDecision>;
}>;

export function configureCoordinatedSession(
	session: AgentSession,
	adapter?: AutomaticGenerationReconciliationAdapter,
): void {
	applyCoordinatedSessionRuntimePolicy(session);
	if (adapter) {
		session.agent.streamFunction = createAutomaticReconciliationStream(
			session.agent.streamFunction,
			adapter,
		);
	}
}

export function applyCoordinatedSessionRuntimePolicy(
	session: AgentSession,
): void {
	const settings = session.settingsManager;
	const providerRetry = settings.getProviderRetrySettings();
	const configuredTransport = settings.getTransport();
	// Codex `auto` can issue a second SSE request after WebSocket failure, which
	// would bypass the same-generation proof required by coordinated Runs.
	const transport = session.model?.api === OPENAI_CODEX_RESPONSES_API &&
		configuredTransport === "auto"
		? "sse"
		: configuredTransport;
	// These overrides are deliberately process-local: coordination must not rewrite
	// the user's ordinary Pi retry, compaction, or transport preferences.
	settings.applyOverrides({
		compaction: { enabled: false },
		retry: {
			enabled: false,
			maxRetries: 0,
			provider: { ...providerRetry, maxRetries: 0 },
		},
		transport,
	});
	session.agent.transport = transport;
}

export function createAutomaticReconciliationStream(
	providerStream: StreamFn,
	adapter: AutomaticGenerationReconciliationAdapter,
): StreamFn {
	const run = Object.freeze({});
	let sequence = 0;
	let currentGeneration: AgentGenerationHandle | undefined;

	return (model, context, options) => {
		const output = createAssistantMessageEventStream();
		const generation = Object.freeze({ run, sequence: ++sequence });
		currentGeneration = generation;
		void reconcileGeneration({
			model,
			providerStream,
			adapter,
			generation,
			isCurrent: () => currentGeneration === generation && options?.signal?.aborted !== true,
			context,
			options,
			output,
		});
		return output;
	};
}

async function reconcileGeneration(options: {
	model: Model<Api>;
	providerStream: StreamFn;
	adapter: AutomaticGenerationReconciliationAdapter;
	generation: AgentGenerationHandle;
	isCurrent(): boolean;
	context: Parameters<StreamFn>[1];
	options: Parameters<StreamFn>[2];
	output: ReturnType<typeof createAssistantMessageEventStream>;
}): Promise<void> {
	let failure: (AssistantMessage & { stopReason: "error" }) | undefined;
	let observedPartial: AssistantMessage | undefined;
	let sawToolCall = false;
	try {
		const source = await options.providerStream(
			options.model,
			options.context,
			options.options,
		);
		for await (const event of source) {
			if (isToolCallEvent(event)) sawToolCall = true;
			if ("partial" in event) observedPartial = event.partial;
			if (event.type === "error" && event.reason === "error") {
				failure = event.error as AssistantMessage & { stopReason: "error" };
				break;
			}
			options.output.push(event);
		}
	} catch (error) {
		options.output.push({
			type: "error",
			reason: "error",
			error: runtimeFailure(options.model, error),
		});
		return;
	}
	if (!failure) return;
	if (sawToolCall || hasToolCall(failure) || !options.isCurrent()) {
		publishFailure(options.output, failure);
		return;
	}

	let decision: AutomaticGenerationReconciliationDecision;
	try {
		decision = await options.adapter.continueGeneration({
			generation: options.generation,
			failure,
		});
	} catch {
		publishFailure(options.output, failure);
		return;
	}
	if (
		decision.kind === "rejected" ||
		decision.generation !== options.generation ||
		!options.isCurrent() ||
		!isSafeContinuedMessage(failure, observedPartial, decision.message)
	) {
		publishFailure(options.output, failure);
		return;
	}
	options.output.push({
		type: "done",
		reason: decision.message.stopReason,
		message: decision.message,
	});
}

function isToolCallEvent(event: AssistantMessageEvent): boolean {
	return event.type === "toolcall_start" ||
		event.type === "toolcall_delta" ||
		event.type === "toolcall_end";
}

function hasToolCall(message: AssistantMessage): boolean {
	return message.content.some(({ type }) => type === "toolCall");
}

function isSafeContinuedMessage(
	failure: AssistantMessage,
	observedPartial: AssistantMessage | undefined,
	continued: AssistantMessage,
): continued is AssistantMessage & { stopReason: "stop" | "length" } {
	if (
		continued.api !== failure.api ||
		continued.provider !== failure.provider ||
		continued.model !== failure.model ||
		(continued.stopReason !== "stop" && continued.stopReason !== "length") ||
		hasToolCall(continued)
	) return false;
	return [observedPartial, failure].every(
		(candidate) => candidate === undefined || contentContinues(candidate, continued),
	);
}

function contentContinues(
	observed: AssistantMessage,
	continued: AssistantMessage,
): boolean {
	if (continued.content.length < observed.content.length) return false;
	return observed.content.every((block, index) => {
		const candidate = continued.content[index];
		if (!candidate || candidate.type !== block.type) return false;
		if (block.type === "text" && candidate.type === "text") {
			return candidate.text.startsWith(block.text);
		}
		if (block.type === "thinking" && candidate.type === "thinking") {
			return candidate.thinking.startsWith(block.thinking);
		}
		return false;
	});
}

function publishFailure(
	stream: ReturnType<typeof createAssistantMessageEventStream>,
	failure: AssistantMessage & { stopReason: "error" },
): void {
	stream.push({ type: "error", reason: "error", error: failure });
}

function runtimeFailure(model: Model<Api>, error: unknown): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}
