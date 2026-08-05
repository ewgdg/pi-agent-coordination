import type {
	AgentSession,
	AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";

export type RunRetentionReason =
	| "owner_host_binding"
	| "pending_delivery"
	| "awaiting_answer"
	| "answer_owed";

export type LiveRunState = Readonly<{
	phase: "starting" | "live" | "ending";
	work?: "active" | "settled";
	attention: "none";
	retentionReasons: readonly RunRetentionReason[];
}>;

export type DormantRunState = Readonly<{
	phase: "dormant";
	retentionReasons: readonly [];
}>;

export type AgentRunState = LiveRunState | DormantRunState;

export type OwnerRunState = LiveRunState;

export class InProcessOwnerRunHost {
	readonly #session: AgentSession;
	#ending = false;
	#retentionReasons: RunRetentionReason[];

	constructor(
		runtime: AgentSessionRuntime | AgentSession,
		retentionReasons: readonly RunRetentionReason[] = ["owner_host_binding"],
	) {
		this.#session = "session" in runtime ? runtime.session : runtime;
		this.#retentionReasons = [...retentionReasons];
	}

	observe(): OwnerRunState {
		return {
			phase: this.#ending ? "ending" : "live",
			work: this.#session.isIdle ? "settled" : "active",
			attention: "none",
			retentionReasons: [...this.#retentionReasons],
		};
	}

	setRetentionReasons(retentionReasons: readonly RunRetentionReason[]): void {
		this.#retentionReasons = [...retentionReasons];
	}

	async shutdown(disposeNativeRuntime: () => Promise<void>): Promise<void> {
		this.#ending = true;
		await disposeNativeRuntime();
	}
}
