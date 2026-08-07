import type { MessageEndEvent } from "@earendil-works/pi-coding-agent";

import type { AgentRecord } from "./agent-record.ts";
import {
	resolveCommittedHumanRequest,
	inspectCommittedHumanRequestResult,
	validateHumanAnswers,
	type HumanAnswer,
	type HumanAnswerCandidate,
	type HumanQuestionAnswer,
	type HumanRequest,
	type HumanRequestInput,
} from "../protocol/human-request.ts";
import type { OwnerIdentity } from "../protocol/owner-identity.ts";
import type { AgentRunHandle } from "../runtime/in-process-agent-host.ts";
import type { ToolCallPointer } from "../protocol/identities.ts";
const INTERRUPTED_MESSAGE = "Human request interrupted before an answer was provided.";
const FENCED_MESSAGE = "Human request ended because its Agent Run is no longer available.";

type PendingPhase = "open" | "submitted" | "fenced";

type PendingHumanRequest = {
	request: HumanRequest;
	record: AgentRecord;
	handle: AgentRunHandle;
	signal: AbortSignal;
	phase: PendingPhase;
	answerCandidate?: HumanAnswerCandidate;
	resolve(candidate: HumanAnswerCandidate): void;
	reject(error: Error): void;
	removeAbortListener(): void;
};

export type HumanAttentionItem = Readonly<{
	requestId: string;
	agentId: string;
	agentLabel: string;
	questionCount: number;
}>;

export type PresentedHumanRequest = HumanAttentionItem & Readonly<{
	request: HumanRequest;
	submit(answers: readonly HumanQuestionAnswer[]): boolean;
	interrupt(): void;
}>;

export type HumanRequestPresentation = Readonly<{
	present(request: PresentedHumanRequest, foreground: boolean): void;
	dismiss(requestId: string): void;
	items(): readonly HumanAttentionItem[];
	focus(requestId: string): Promise<void>;
}>;

// Tests may force only the concrete admission and pre-append races below. The
// hook cannot access a session, host, or Run handle, and its fence is pinned to
// the exact admitted Run.
export type HumanRequestBoundaryHooks = Readonly<{
	afterAdmission?(context: Readonly<{
		agentId: string;
		requestId: string;
		fenceExactRun(): Promise<void>;
	}>): void;
	beforeResultCommit?(context: Readonly<{
		agentId: string;
		requestId: string;
		failExactRun(): void;
	}>): void;
}>;

const unavailablePresentation: HumanRequestPresentation = {
	present() {
		throw new Error("Human Request presentation is unavailable");
	},
	dismiss() {},
	items: () => [],
	async focus(requestId) {
		throw new Error(`unknown_identity: Human Request ${requestId}`);
	},
};

export class HumanRequestCoordinator {
	readonly #agents: Map<string, AgentRecord>;
	readonly #ownerIdentity: OwnerIdentity;
	readonly #presentation: HumanRequestPresentation;
	readonly #boundaryHooks: HumanRequestBoundaryHooks;
	readonly #interruptRun: (record: AgentRecord) => void;
	readonly #suspendExecution: (record: AgentRecord) => void;
	readonly #beginHumanWaiting: (source: ToolCallPointer) => void;
	readonly #beginHumanResultCommit: (source: ToolCallPointer) => void;
	readonly #pendingByRequestId = new Map<string, PendingHumanRequest>();

	constructor(options: {
		agents: Map<string, AgentRecord>;
		ownerIdentity: OwnerIdentity;
		presentation?: HumanRequestPresentation;
		boundaryHooks?: HumanRequestBoundaryHooks;
		interruptRun(record: AgentRecord): void;
		suspendExecution(record: AgentRecord): void;
		beginHumanWaiting(source: ToolCallPointer): void;
		beginHumanResultCommit(source: ToolCallPointer): void;
	}) {
		this.#agents = options.agents;
		this.#ownerIdentity = options.ownerIdentity;
		this.#presentation = options.presentation ?? unavailablePresentation;
		this.#boundaryHooks = options.boundaryHooks ?? {};
		this.#interruptRun = options.interruptRun;
		this.#suspendExecution = options.suspendExecution;
		this.#beginHumanWaiting = options.beginHumanWaiting;
		this.#beginHumanResultCommit = options.beginHumanResultCommit;
	}

	async ask(
		callerAgentId: string,
		toolCallId: string,
		input: HumanRequestInput,
		signal: AbortSignal | undefined,
	): Promise<HumanAnswerCandidate> {
		if (!signal) {
			throw new Error("invariant_violation: Human Request has no active Run signal");
		}
		if (signal.aborted) throw new Error(INTERRUPTED_MESSAGE);
		const record = this.#requireAgent(callerAgentId);
		const request = resolveCommittedHumanRequest({
			agentId: callerAgentId,
			sessionManager: record.host.sessionManager,
			toolCallId,
			providedInput: input,
		});
		const handle = record.host.currentHandle();
		if (!handle) throw new Error("Agent Run is unavailable");
		if (this.#pendingByRequestId.has(request.requestId)) {
			throw new Error(`invariant_violation: Human Request ${request.requestId} is already pending`);
		}
		let resolveCandidate!: (candidate: HumanAnswerCandidate) => void;
		let rejectAnswer!: (error: Error) => void;
		const candidatePromise = new Promise<HumanAnswerCandidate>((resolve, reject) => {
			resolveCandidate = resolve;
			rejectAnswer = reject;
		});
		const onAbort = () => this.#fence(request.requestId, INTERRUPTED_MESSAGE);
		signal.addEventListener("abort", onAbort, { once: true });
		const pending: PendingHumanRequest = {
			request,
			record,
			handle,
			signal,
			phase: "open",
			resolve: resolveCandidate,
			reject: rejectAnswer,
			removeAbortListener: () => signal.removeEventListener("abort", onAbort),
		};
		record.host.setRunFenceHandler((fencedHandle) =>
			this.#fenceRun(callerAgentId, fencedHandle),
		);
		try {
			record.host.beginInputRequired(handle, request.requestId);
			this.#suspendExecution(record);
			this.#pendingByRequestId.set(request.requestId, pending);
			this.#beginHumanWaiting(request.source);
			this.#presentation.present(
				{
					requestId: request.requestId,
					agentId: callerAgentId,
					agentLabel: record.identity.configuration.label,
					questionCount: request.questions.length,
					request,
					submit: (answers) => this.#submit(request.requestId, answers),
					interrupt: () => this.#interrupt(request.requestId),
				},
				callerAgentId === this.#ownerIdentity.agentId,
			);
			this.#boundaryHooks.afterAdmission?.({
				agentId: callerAgentId,
				requestId: request.requestId,
				fenceExactRun: () => record.host.lane.run(() => {
					if (!record.host.isCurrent(handle)) return;
					return record.host.discardAndEndInLane("failure");
				}),
			});
		} catch (error) {
			if (this.#pendingByRequestId.has(request.requestId)) {
				this.#complete(pending);
			} else {
				pending.removeAbortListener();
			}
			throw error;
		}
		return candidatePromise;
	}

	guardResultCommit(
		callerAgentId: string,
		message: MessageEndEvent["message"],
	): MessageEndEvent["message"] | undefined {
		if (
			message.role !== "toolResult" ||
			message.toolName !== "ask_user_question" ||
			message.isError
		) return undefined;
		const pending = [...this.#pendingByRequestId.values()].find(
			(candidate) =>
				candidate.request.requesterAgentId === callerAgentId &&
				candidate.request.source.toolCallId === message.toolCallId,
		);
		if (!pending) return undefined;
		if (
			pending.phase === "submitted"
		) {
			this.#boundaryHooks.beforeResultCommit?.({
				agentId: callerAgentId,
				requestId: pending.request.requestId,
				failExactRun: () => pending.record.host.failExactRun(pending.handle),
			});
		}
		if (
			!pending.record.host.acceptsInputRequired(
				pending.handle,
				pending.request.requestId,
			)
		) {
			this.#fence(pending.request.requestId, FENCED_MESSAGE);
		}
		if (pending.phase !== "fenced") return undefined;
		return {
			...message,
			content: [{ type: "text", text: FENCED_MESSAGE }],
			details: undefined,
			isError: true,
		};
	}

	reconcileCommittedResults(callerAgentId: string): void {
		for (const pending of [...this.#pendingByRequestId.values()]) {
			if (pending.request.requesterAgentId !== callerAgentId) continue;
			const inspection = inspectCommittedHumanRequestResult({
				request: pending.request,
				sessionManager: pending.record.host.sessionManager,
			});
			if (inspection.state === "pending") continue;
			if (
				inspection.state === "answered" &&
				!sameCommittedAnswerToCandidate(
					inspection.answer,
					pending.answerCandidate,
				)
			) {
				throw new Error(
					`invariant_violation: Human Answer ${pending.request.requestId} differs from its submission`,
				);
			}
			this.#complete(pending);
		}
	}

	attentionItems(callerAgentId: string): readonly HumanAttentionItem[] {
		const caller = this.#requireAgent(callerAgentId);
		return this.#presentation.items().filter((item) => {
			if (callerAgentId === this.#ownerIdentity.agentId) return true;
			if (item.agentId === callerAgentId) return true;
			return this.#agents.get(item.agentId)?.identity.directSpawnerAgentId ===
				caller.identity.agentId;
		});
	}

	async focus(callerAgentId: string, requestId: string): Promise<void> {
		if (!this.attentionItems(callerAgentId).some((item) => item.requestId === requestId)) {
			throw new Error(`unknown_identity: Human Request ${requestId}`);
		}
		await this.#presentation.focus(requestId);
	}

	#submit(requestId: string, answers: readonly HumanQuestionAnswer[]): boolean {
		const pending = this.#pendingByRequestId.get(requestId);
		if (
			!pending ||
			pending.phase !== "open" ||
			pending.signal.aborted ||
			!pending.record.host.acceptsInputRequired(pending.handle, requestId)
		) {
			return false;
		}
		const completeAnswers = validateHumanAnswers(pending.request.questions, answers);
		const candidate: HumanAnswerCandidate = {
			requestId,
			answers: completeAnswers,
		};
		pending.phase = "submitted";
		pending.answerCandidate = candidate;
		this.#beginHumanResultCommit(pending.request.source);
		pending.resolve(candidate);
		return true;
	}

	#interrupt(requestId: string): void {
		const pending = this.#pendingByRequestId.get(requestId);
		if (!pending || pending.phase !== "open") return;
		this.#interruptRun(pending.record);
		this.#fence(requestId, INTERRUPTED_MESSAGE);
	}

	#fenceRun(agentId: string, handle: AgentRunHandle): void {
		let matched = false;
		for (const pending of this.#pendingByRequestId.values()) {
			if (pending.request.requesterAgentId !== agentId || pending.handle !== handle) continue;
			matched = true;
			this.#fence(pending.request.requestId, FENCED_MESSAGE);
		}
		if (!matched) return;
		const record = this.#requireAgent(agentId);
		// Failure notification can originate inside an existing lane disposal. Queue
		// exact-handle cleanup so it cannot re-enter that disposal or touch a successor.
		void record.host.lane.run(() => {
			if (!record.host.isCurrent(handle)) return;
			return record.host.discardAndEndInLane("failure");
		});
	}

	#fence(requestId: string, message: string): void {
		const pending = this.#pendingByRequestId.get(requestId);
		if (!pending || pending.phase === "fenced") return;
		pending.phase = "fenced";
		this.#beginHumanResultCommit(pending.request.source);
		// Submission and fencing are synchronous phase transitions. The last
		// pre-append guard above rechecks this phase, so an asynchronous Run fence
		// can still defeat a submitted candidate until native result commitment.
		this.#presentation.dismiss(requestId);
		pending.reject(new Error(message));
	}

	#complete(pending: PendingHumanRequest): void {
		pending.removeAbortListener();
		pending.record.host.endInputRequired(pending.handle, pending.request.requestId);
		this.#presentation.dismiss(pending.request.requestId);
		this.#pendingByRequestId.delete(pending.request.requestId);
	}

	#requireAgent(agentId: string): AgentRecord {
		const record = this.#agents.get(agentId);
		if (!record) throw new Error(`unknown_identity: ${agentId}`);
		return record;
	}
}

function sameCommittedAnswerToCandidate(
	value: HumanAnswer,
	expected: HumanAnswerCandidate | undefined,
): boolean {
	return expected !== undefined && JSON.stringify(value) === JSON.stringify(expected);
}
