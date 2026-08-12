import type {
	AgentRuntimeDelivery,
	AgentRuntimeDeliveryDispatch,
	AgentRuntimeWorkState,
	EffectiveRuntimeSnapshot,
	ToolBatchClassification,
	TranscriptCommitConfirmation,
} from "./agent-runtime-host.ts";
import type { HostedAgentProjection } from "./hosted-agent-projection.ts";

export type HostedRuntimeEvent =
	| Readonly<{ type: "state_changed" }>
	| Readonly<{
		type: "agent_end";
		outcome: "completed" | "aborted" | "error";
		willRetry: boolean;
	}>
	| Readonly<{ type: "agent_settled" }>;

/** Internal process-neutral adapter owned by one prepared/live host Runtime. */
export interface HostedAgentRuntime {
	readonly projection: HostedAgentProjection | undefined;
	snapshot(): EffectiveRuntimeSnapshot;
	synchronizeState(): Promise<void>;
	workState(): AgentRuntimeWorkState;
	queuedInputCount(): number;
	classifyToolBatch(toolNames: readonly string[]): ToolBatchClassification;
	cancellationSignal(): AbortSignal;
	deliver(
		delivery: AgentRuntimeDelivery,
		confirmation?: TranscriptCommitConfirmation,
	): AgentRuntimeDeliveryDispatch;
	continueFromCommittedInput(): Promise<void>;
	subscribe(handler: (event: HostedRuntimeEvent) => void): () => void;
	clearQueue(): Promise<Readonly<{ steering: string[]; followUp: string[] }>>;
	abort(): Promise<void>;
	waitForIdle(): Promise<void>;
	dispose(): Promise<void>;
}
