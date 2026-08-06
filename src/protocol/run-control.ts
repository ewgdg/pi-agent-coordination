import type { SessionManager } from "@earendil-works/pi-coding-agent";

import {
	deriveMessageIdentity,
	resolveCommittedToolCall,
	type ToolCallPointer,
} from "./identities.ts";
import type { Message } from "./message.ts";

export type RunControlInput =
	| Readonly<{
		operation: "interrupt";
		agentId: string;
	}>
	| Readonly<{
		operation: "resume";
		agentId: string;
		content: string;
	}>
	| Readonly<{
		operation: "terminate";
		agentId: string;
	}>;

export type RunInterruptionReceipt = Readonly<{
	agentId: string;
	disposition: "held" | "already_held" | "not_running";
}>;

export type RunResumeReceipt = Readonly<{
	agentId: string;
	messageId: string;
}> & (
	| Readonly<{ delivery: "pending" }>
	| Readonly<{
		delivery: "rejected";
		rejectionReason: "not_held" | "resume_slot_occupied" | "target_unavailable";
	}>
);

export type RunTerminationReceipt = Readonly<{ agentId: string }> & (
	| Readonly<{
		disposition: "terminated" | "not_running";
		residualRequests: Readonly<{
			incoming: number;
			outgoing: number;
		}>;
	}>
	| Readonly<{
		disposition: "rejected";
		rejectionReason: "interactive_selection";
	}>
);

export type RunControlReceipt =
	| RunInterruptionReceipt
	| RunResumeReceipt
	| RunTerminationReceipt;

export function validateRunControlInput(value: unknown): RunControlInput {
	if (!isRecord(value)) throw new Error("invalid_input: Run control input must be an object");
	if (typeof value.agentId !== "string" || value.agentId.trim().length === 0) {
		throw new Error("invalid_input: Run control Agent identity must not be blank");
	}
	if (value.operation === "interrupt" && Object.keys(value).length === 2) {
		return { operation: "interrupt", agentId: value.agentId };
	}
	if (value.operation === "terminate" && Object.keys(value).length === 2) {
		return { operation: "terminate", agentId: value.agentId };
	}
	if (
		value.operation === "resume" &&
		Object.keys(value).length === 3 &&
		typeof value.content === "string" &&
		value.content.trim().length > 0
	) {
		return { operation: "resume", agentId: value.agentId, content: value.content };
	}
	throw new Error("invalid_input: invalid Run control input");
}

export function resolveCommittedRunControl(options: {
	callerAgentId: string;
	sessionManager: SessionManager;
	toolCallId: string;
	providedInput: RunControlInput;
}): Readonly<{ source: ToolCallPointer; input: RunControlInput }> {
	const { source, input } = resolveCommittedToolCall({
		agentId: options.callerAgentId,
		sessionManager: options.sessionManager,
		toolCallId: options.toolCallId,
		toolName: "agent_control",
	});
	const committedInput = validateRunControlInput(input);
	if (!sameRunControlInput(committedInput, options.providedInput)) {
		throw new Error("invariant_violation: executed Run control input differs from its source");
	}
	return { source, input: committedInput };
}

export function createSupervisoryResumeMessage(options: {
	workflowId: string;
	fromAgentId: string;
	input: Extract<RunControlInput, { operation: "resume" }>;
	source: ToolCallPointer;
}): Extract<Message, { kind: "message" }> {
	return {
		kind: "message",
		origin: "agent_control",
		messageId: deriveMessageIdentity(options.source),
		workflowId: options.workflowId,
		fromAgentId: options.fromAgentId,
		targetAgentId: options.input.agentId,
		deliveryMode: "steer",
		source: options.source,
		content: options.input.content,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameRunControlInput(left: RunControlInput, right: RunControlInput): boolean {
	if (left.operation !== right.operation || left.agentId !== right.agentId) return false;
	return left.operation !== "resume" ||
		(right.operation === "resume" && left.content === right.content);
}
