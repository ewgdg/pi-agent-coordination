import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

import type { TerminalProjection } from "../presentation/terminal-projection.ts";
import type { ModelVisibleRunFailureRecovery } from "../protocol/run-failure-recovery.ts";
import type { ModelVisibleMessageDelivery } from "../protocol/message-delivery.ts";
import type { ModelVisibleModeratorRoutineStart } from "../protocol/moderator-input.ts";
import type { ModelVisibleObligationReminder } from "../protocol/obligation-reminder.ts";
import type {
	ModelReference,
	RuntimeThinkingLevel,
} from "../protocol/runtime-configuration.ts";
import type { SerialLane } from "./serial-lane.ts";

export type RunRetentionReason =
	| "owner_host_binding"
	| "pending_delivery"
	| "awaiting_answer"
	| "answer_owed"
	| "interruption_hold"
	| "moderator_handling";

export type AgentRuntimeRetentionReason = "interactive_selection";
export type AgentRetentionReason = RunRetentionReason | AgentRuntimeRetentionReason;
export type AgentRetention = Readonly<{
	reason: AgentRetentionReason;
	count: number;
}>;

export type LiveRunState = Readonly<{
	phase: "starting" | "live" | "ending";
	work?: "active" | "settled";
	attention: "none" | "input_required";
	retentionReasons: readonly AgentRetention[];
}>;
export type DormantRunState = Readonly<{
	phase: "dormant";
	retentionReasons: readonly [];
}>;
export type AgentRunState = LiveRunState | DormantRunState;
export type AgentRunHandle = Readonly<{ sequence: number }>;
export type InterruptionHoldHandle = Readonly<{
	run: AgentRunHandle;
	sequence: number;
}>;
export type AgentRunSettlement = "settled" | "failed";
export type AgentRunEndCause = "clean" | "failure" | "termination" | "shutdown";
export type ResidualRequestRelationships = Readonly<{
	awaitingAnswerRequestIds: readonly string[];
	answerOwedRequestIds: readonly string[];
}>;

export type EffectiveRuntimeSnapshot = Readonly<{
	cwd: string;
	model: ModelReference;
	thinking: RuntimeThinkingLevel;
	allowedTools: readonly string[];
	tools: readonly string[];
	skills: readonly string[];
	skillSources: readonly Readonly<{ name: string; filePath: string }>[];
	fileExtensionPaths: readonly string[];
	projectTrusted: boolean;
	sessionId: string;
}>;

export type AgentRuntimeWorkState = "active" | "settled" | "unavailable";
export type ToolBatchClassification = "blocking" | "asynchronous";

export type AgentRuntimeDelivery =
	| Readonly<{
		kind: "custom";
		message:
			| ModelVisibleMessageDelivery
			| ModelVisibleModeratorRoutineStart
			| ModelVisibleObligationReminder
			| ModelVisibleRunFailureRecovery;
		triggerTurn: true;
		deliverAs?: "steer" | "followUp";
	}>
	| Readonly<{
		kind: "user";
		content: string | readonly (TextContent | ImageContent)[];
		deliverAs?: "steer" | "followUp";
	}>;
export type TranscriptCommitConfirmation = Readonly<{
	inspectCommit(): boolean;
}>;
export type AgentRuntimeDeliveryDispatch = Readonly<{
	completion: Promise<void>;
	transcriptCommit?: Promise<boolean>;
}>;

/** Coordination-facing Runtime Host seam. Pi runtime objects remain behind it. */
export interface AgentRuntimeHost {
	readonly lane: SerialLane;
	observe(): AgentRunState;
	currentHandle(): AgentRunHandle | undefined;
	currentProjection(): TerminalProjection | undefined;
	projectionInputSubmissionIsFenced(sequence: number): boolean;
	effectiveRuntimeSnapshot(): EffectiveRuntimeSnapshot | undefined;
	synchronizeRuntimeState(): Promise<EffectiveRuntimeSnapshot>;
	currentWorkState(): AgentRuntimeWorkState;
	classifyToolBatch(toolNames: readonly string[]): ToolBatchClassification;
	exactRunCancellationSignal(handle: AgentRunHandle): AbortSignal;
	deliverInLane(
		delivery: AgentRuntimeDelivery,
		confirmation?: TranscriptCommitConfirmation,
	): AgentRuntimeDeliveryDispatch;
	startInLane(reasons?: readonly AgentRetentionReason[]): Promise<AgentRunHandle>;
	prepareInLane(reasons?: readonly AgentRetentionReason[]): Promise<void>;
	beginShutdown(): Promise<boolean>;
	cancelRuntimeInitialization(projection: TerminalProjection, error: unknown): Promise<boolean>;
	addSettledHandler(
		handler: (handle: AgentRunHandle, settlement: AgentRunSettlement) => void,
	): () => void;
	addEndedHandler(
		handler: (handle: AgentRunHandle, cause: AgentRunEndCause) => void,
	): () => void;
	addStateChangeHandler(handler: () => void): () => void;
	setProjectionInputSettledHandler(handler: () => void): void;
	setRunFenceHandler(handler: (handle: AgentRunHandle) => void): void;
	setRunStartInitializer(initializer: () => ResidualRequestRelationships): void;
	setRunStartedHandler(
		handler: (handle: AgentRunHandle) => void | Promise<void>,
	): void;
	setRunEndingHandler(
		handler: (
			handle: AgentRunHandle,
			cause: Exclude<AgentRunEndCause, "clean">,
		) => void | Promise<void>,
	): void;
	initializeCurrentRunRelationships(): void;
	latestStartedRunSequence(): number;
	currentRunFailed(): boolean;
	isCurrent(handle: AgentRunHandle): boolean;
	blocksOrdinaryDelivery(): boolean;
	isInterrupting(): boolean;
	currentInterruptionHold(): InterruptionHoldHandle | undefined;
	isCurrentInterruptionHold(hold: InterruptionHoldHandle): boolean;
	beginIsolatedResumptionInLane(hold: InterruptionHoldHandle): boolean;
	commitIsolatedResumptionInLane(hold: InterruptionHoldHandle): boolean;
	cancelIsolatedResumptionInLane(hold: InterruptionHoldHandle): void;
	finishIsolatedResumptionInLane(handle: AgentRunHandle): void;
	interruptCurrentRunInLane(): Promise<"held" | "already_held" | "not_running">;
	prepareInterruption(): void;
	beginInputRequired(handle: AgentRunHandle, requestId: string): void;
	acceptsInputRequired(handle: AgentRunHandle, requestId: string): boolean;
	failExactRun(handle: AgentRunHandle): void;
	endInputRequired(handle: AgentRunHandle, requestId: string): void;
	addRetentionReason(reason: AgentRetentionReason, requestId?: string): void;
	removeRetentionReason(reason: AgentRetentionReason, requestId?: string): void;
	hasRetentionReason(reason: AgentRetentionReason, requestId?: string): boolean;
	requestRelationshipIds(reason: "awaiting_answer" | "answer_owed"): readonly string[];
	residualRequestCounts(): Readonly<{ incoming: number; outgoing: number }>;
	queuedInputCount(): number;
	releaseIfEligibleInLane(handle: AgentRunHandle): Promise<"released" | "retained" | "stale">;
	releasePreparedRuntimeInLane(): Promise<"released" | "retained" | "stale">;
	discardAndEndInLane(
		cause: Exclude<AgentRunEndCause, "clean">,
		disposeRuntime?: () => Promise<void>,
	): Promise<void>;
}
