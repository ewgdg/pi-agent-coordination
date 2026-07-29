import type {
	AgentSession,
	AgentSessionRuntimeDiagnostic,
	AgentSessionServices,
} from "@earendil-works/pi-coding-agent";

export type LiveSessionKey =
	| "owner"
	| "researcher"
	| "source-scout"
	| "synthesizer"
	| "builder"
	| "reviewer";

export type LiveSessionSlot = {
	key: LiveSessionKey;
	session: AgentSession;
	services: AgentSessionServices;
	diagnostics: AgentSessionRuntimeDiagnostic[];
	modelFallbackMessage?: string;
};

export interface LiveSessionSelection {
	activate(slot: LiveSessionSlot): Promise<void>;
}

export class LiveSessionMultiplexer {
	readonly #selection: LiveSessionSelection;
	readonly #sessions = new Map<LiveSessionKey, LiveSessionSlot>();
	readonly #disposedSessions = new Set<LiveSessionKey>();
	#selectedKey: LiveSessionKey;

	constructor(selection: LiveSessionSelection, owner: LiveSessionSlot) {
		this.#selection = selection;
		this.#selectedKey = owner.key;
		this.#sessions.set(owner.key, owner);
	}

	get selectedKey(): LiveSessionKey {
		return this.#selectedKey;
	}

	register(slot: LiveSessionSlot): void {
		if (this.#sessions.has(slot.key)) {
			throw new Error(`Live session already registered: ${slot.key}`);
		}
		this.#sessions.set(slot.key, slot);
	}

	async select(key: LiveSessionKey): Promise<void> {
		if (key === this.#selectedKey) return;
		const slot = this.#sessions.get(key);
		if (!slot) throw new Error(`Unknown live session: ${key}`);

		await this.#selection.activate(slot);
		this.#selectedKey = key;
	}

	async shutdownRetainedSessions(): Promise<void> {
		for (const [key, slot] of this.#sessions) {
			if (key === this.#selectedKey || this.#disposedSessions.has(key)) continue;
			if (slot.session.extensionRunner.hasHandlers("session_shutdown")) {
				await slot.session.extensionRunner.emit({
					type: "session_shutdown",
					reason: "quit",
				});
			}
			slot.session.dispose();
			this.#disposedSessions.add(key);
		}
	}
}
