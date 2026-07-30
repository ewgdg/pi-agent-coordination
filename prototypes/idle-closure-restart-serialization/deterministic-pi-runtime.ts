import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "coordination-prototype";
// Pi validates a base URL for custom models even when streamSimple handles every request locally.
const PROVIDER_BASE_URL = "http://coordination-prototype.invalid";
const MODEL_ID = "deterministic-agent";
const MODEL_DELAY_MS = 12;

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
} as const;

export type PrototypePiRuntime = {
	modelRuntime: ModelRuntime;
	model: Model<Api>;
};

export async function createPrototypePiRuntime(): Promise<PrototypePiRuntime> {
	const modelRuntime = await ModelRuntime.create({
		allowModelNetwork: false,
		modelsPath: null,
	});
	modelRuntime.registerProvider(PROVIDER_ID, {
		name: "Coordination prototype",
		baseUrl: PROVIDER_BASE_URL,
		api: PROVIDER_ID,
		apiKey: "in-memory-prototype",
		models: [
			{
				id: MODEL_ID,
				name: "Deterministic Agent",
				reasoning: false,
				input: ["text"],
				cost: EMPTY_USAGE.cost,
				contextWindow: 16_384,
				maxTokens: 256,
			},
		],
		streamSimple: deterministicStream,
	});

	const model = modelRuntime.getModel(PROVIDER_ID, MODEL_ID);
	if (!model) throw new Error("Deterministic prototype model was not registered");
	return { modelRuntime, model };
}

function deterministicStream(
	model: Model<Api>,
	_context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void emitDeterministicResponse(stream, model, options?.signal);
	return stream;
}

async function emitDeterministicResponse(
	stream: AssistantMessageEventStream,
	model: Model<Api>,
	signal?: AbortSignal,
): Promise<void> {
	const startedAt = Date.now();
	const responseText = "Coordination input observed.";
	const partial = createMessage(model, startedAt, [], "stop");
	stream.push({ type: "start", partial });

	await delay(MODEL_DELAY_MS);
	if (signal?.aborted) {
		const error = createMessage(model, startedAt, [], "aborted", "Prototype Run interrupted");
		stream.push({ type: "error", reason: "aborted", error });
		return;
	}

	const textStarted = createMessage(model, startedAt, [{ type: "text", text: "" }], "stop");
	stream.push({ type: "text_start", contentIndex: 0, partial: textStarted });
	const textComplete = createMessage(
		model,
		startedAt,
		[{ type: "text", text: responseText }],
		"stop",
	);
	stream.push({
		type: "text_delta",
		contentIndex: 0,
		delta: responseText,
		partial: textComplete,
	});
	stream.push({
		type: "text_end",
		contentIndex: 0,
		content: responseText,
		partial: textComplete,
	});
	stream.push({ type: "done", reason: "stop", message: textComplete });
}

function createMessage(
	model: Model<Api>,
	timestamp: number,
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: EMPTY_USAGE,
		stopReason,
		errorMessage,
		timestamp,
	};
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
