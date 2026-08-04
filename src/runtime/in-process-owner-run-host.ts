import type {
	AgentSession,
	AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";

export type OwnerRunState = Readonly<{
	phase: "live" | "ending";
	work: "active" | "settled";
	attention: "none";
	retentionReasons: readonly ["owner_host_binding"];
}>;

export class InProcessOwnerRunHost {
	readonly #session: AgentSession;
	#ending = false;

	constructor(runtime: AgentSessionRuntime) {
		this.#session = runtime.session;
	}

	observe(): OwnerRunState {
		return {
			phase: this.#ending ? "ending" : "live",
			work: this.#session.isIdle ? "settled" : "active",
			attention: "none",
			retentionReasons: ["owner_host_binding"],
		};
	}

	async shutdown(disposeNativeRuntime: () => Promise<void>): Promise<void> {
		this.#ending = true;
		await disposeNativeRuntime();
	}
}
