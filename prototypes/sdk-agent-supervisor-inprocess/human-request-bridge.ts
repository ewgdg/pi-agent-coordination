import { EventEmitter } from "node:events";

import type { AgentSession } from "@earendil-works/pi-coding-agent";

import type { LiveSessionKey } from "./live-session-multiplexer.ts";

export type PendingHumanRequest = {
	agentKey: LiveSessionKey;
	prompt: string;
};

type NativeTranscriptMessage = Parameters<AgentSession["sessionManager"]["appendMessage"]>[0];

type PendingRequest = PendingHumanRequest & {
	answer: Promise<string>;
	resolve(answer: string): void;
};

type NativeTranscriptSession = {
	_emit(event: {
		type: "message_start" | "message_end";
		message: NativeTranscriptMessage;
	}): void;
};

export class HumanRequestBridge extends EventEmitter {
	readonly #getSession: (key: LiveSessionKey) => AgentSession;
	readonly #pending = new Map<LiveSessionKey, PendingRequest>();

	constructor(getSession: (key: LiveSessionKey) => AgentSession) {
		super();
		this.#getSession = getSession;
	}

	request(agentKey: LiveSessionKey, prompt: string): Promise<string> {
		if (this.#pending.has(agentKey)) {
			throw new Error(`${agentKey} already has a pending Human Request`);
		}

		let resolveAnswer!: (answer: string) => void;
		const answer = new Promise<string>((resolve) => {
			resolveAnswer = resolve;
		});
		const pending: PendingRequest = {
			agentKey,
			prompt,
			answer,
			resolve: resolveAnswer,
		};
		this.#pending.set(agentKey, pending);

		try {
			const session = this.#getSession(agentKey);
			appendNativeTranscriptMessage(
				session,
				createHumanRequestMessage(session, prompt),
			);
		} catch (error) {
			this.#pending.delete(agentKey);
			throw error;
		}

		this.emit("change");
		return answer;
	}

	answer(agentKey: LiveSessionKey, text: string): boolean {
		const pending = this.#pending.get(agentKey);
		if (!pending) return false;

		appendNativeTranscriptMessage(this.#getSession(agentKey), {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		});
		this.#pending.delete(agentKey);
		this.emit("change");
		pending.resolve(text);
		return true;
	}

	pendingFor(agentKey: LiveSessionKey): PendingHumanRequest | undefined {
		const pending = this.#pending.get(agentKey);
		if (!pending) return undefined;
		return { agentKey: pending.agentKey, prompt: pending.prompt };
	}

	allPending(): PendingHumanRequest[] {
		return [...this.#pending.values()].map(({ agentKey, prompt }) => ({ agentKey, prompt }));
	}
}

function createHumanRequestMessage(
	session: AgentSession,
	prompt: string,
): NativeTranscriptMessage {
	const model = session.model;
	if (!model) throw new Error("A child needs a selected model before requesting human input");
	return {
		role: "assistant",
		content: [{ type: "text", text: prompt }],
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
		stopReason: "stop",
		timestamp: Date.now(),
	} as NativeTranscriptMessage;
}

function appendNativeTranscriptMessage(
	session: AgentSession,
	message: NativeTranscriptMessage,
): void {
	// The multiplexer is pinned to Pi 0.82.1. Feeding its native session event
	// seam preserves Pi's exact user/assistant components and turn spacing.
	session.messages.push(message);
	const nativeSession = session as unknown as NativeTranscriptSession;
	nativeSession._emit({ type: "message_start", message });
	nativeSession._emit({ type: "message_end", message });
	session.sessionManager.appendMessage(message);
}
