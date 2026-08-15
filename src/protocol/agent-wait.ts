import { isDeepStrictEqual } from "node:util";

import type { TranscriptInspection } from "../transcript/agent-transcript.ts";
import {
	currentCoordinationScope,
	deriveMessageIdentity,
	ProtocolInvariantError,
	resolveCommittedToolCall,
	type ToolCallPointer,
} from "./identities.ts";

export type AgentWaitInput = Readonly<{
	requestMessageIds: readonly string[];
}>;

export type AgentWaitAnswer =
	| Readonly<{
		disposition: "answer_delivered";
		requestMessageId: string;
		answerId: string;
		fromAgentId: string;
		answer: string;
		answerSource: ToolCallPointer;
	}>
	| Readonly<{
		disposition: "answer_already_delivered";
		requestMessageId: string;
		answerId: string;
		deliveryEvidence: Readonly<{ agentId: string; entryId: string }>;
	}>;

export type AgentWaitResult = Readonly<{
	answers: readonly AgentWaitAnswer[];
}>;

export type AgentWaitResultInspection =
	| Readonly<{ state: "pending" }>
	| Readonly<{ state: "interrupted"; resultEntryId: string }>
	| Readonly<{
		state: "completed";
		result: AgentWaitResult;
		resultEntryId: string;
	}>;

export function resolveCommittedAgentWaitInput(options: {
	agentId: string;
	transcript: TranscriptInspection;
	toolCallId: string;
	providedInput: AgentWaitInput;
}): AgentWaitInput {
	const input = committedAgentWaitInput(options);
	const provided = validateAgentWaitInput(options.providedInput);
	if (!isDeepStrictEqual(input, provided)) {
		throw new Error("invariant_violation: Agent Wait input differs from its committed call");
	}
	return input;
}

export function inspectCommittedAgentWaitResult(options: {
	agentId: string;
	transcript: TranscriptInspection;
	toolCallId: string;
}): AgentWaitResultInspection {
	const matches = currentCoordinationScope(options.transcript, options.agentId).filter(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === options.toolCallId,
	);
	if (matches.length > 1) {
		throw new ProtocolInvariantError(
			`Agent Wait ${options.toolCallId} has multiple native results`,
		);
	}
	const match = matches[0];
	if (!match || match.type !== "message" || match.message.role !== "toolResult") {
		return { state: "pending" };
	}
	if (match.message.toolName !== "agent_wait") {
		throw new ProtocolInvariantError(
			`Agent Wait ${options.toolCallId} result names ${match.message.toolName}`,
		);
	}
	if (match.message.isError) {
		return { state: "interrupted", resultEntryId: match.id };
	}
	const input = committedAgentWaitInput(options);
	const result = validateAgentWaitResult(match.message.details);
	if (!isDeepStrictEqual(
		result.answers.map(({ requestMessageId }) => requestMessageId),
		input.requestMessageIds,
	)) {
		throw new ProtocolInvariantError(
			"Agent Wait result does not preserve its selected Request identities",
		);
	}
	if (
		match.message.content.length !== 1 ||
		match.message.content[0]?.type !== "text"
	) {
		throw new ProtocolInvariantError("Agent Wait result content has an invalid shape");
	}
	let content: unknown;
	try {
		content = JSON.parse(match.message.content[0].text);
	} catch {
		throw new ProtocolInvariantError("Agent Wait result content is not valid JSON");
	}
	if (!isDeepStrictEqual(content, result)) {
		throw new ProtocolInvariantError("Agent Wait result content differs from its details");
	}
	return { state: "completed", result, resultEntryId: match.id };
}

export function validateAgentWaitResult(value: unknown): AgentWaitResult {
	if (!isRecord(value) || !sameKeys(value, ["answers"]) || !Array.isArray(value.answers)) {
		throw new ProtocolInvariantError("Agent Wait result has an invalid shape");
	}
	const answers = value.answers.map((candidate): AgentWaitAnswer => {
		if (!isRecord(candidate) || typeof candidate.disposition !== "string") {
			throw new ProtocolInvariantError("Agent Wait Answer has an invalid shape");
		}
		if (candidate.disposition === "answer_delivered") {
			if (
				!sameKeys(candidate, [
					"answer", "answerId", "answerSource", "disposition",
					"fromAgentId", "requestMessageId",
				]) ||
				!isToolCallPointer(candidate.answerSource) ||
				typeof candidate.requestMessageId !== "string" ||
				typeof candidate.answerId !== "string" ||
				typeof candidate.fromAgentId !== "string" ||
				typeof candidate.answer !== "string" || candidate.answer.length === 0 ||
				candidate.answerId !== deriveMessageIdentity(candidate.answerSource) ||
				candidate.fromAgentId !== candidate.answerSource.agentId
			) throw new ProtocolInvariantError("Agent Wait delivered Answer is invalid");
			return candidate as AgentWaitAnswer;
		}
		if (
			candidate.disposition !== "answer_already_delivered" ||
			!sameKeys(candidate, [
				"answerId", "deliveryEvidence", "disposition", "requestMessageId",
			]) ||
			typeof candidate.requestMessageId !== "string" ||
			typeof candidate.answerId !== "string" || candidate.answerId.length === 0 ||
			!isEntryPointer(candidate.deliveryEvidence)
		) throw new ProtocolInvariantError("Agent Wait prior Answer Delivery is invalid");
		return candidate as AgentWaitAnswer;
	});
	const requestIds = answers.map(({ requestMessageId }) => requestMessageId);
	if (
		answers.length === 0 ||
		requestIds.some((requestId) => requestId.length === 0) ||
		new Set(requestIds).size !== requestIds.length
	) throw new ProtocolInvariantError("Agent Wait result has invalid Request identities");
	return { answers };
}

export function validateAgentWaitInput(value: unknown): AgentWaitInput {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		Object.keys(value).length !== 1 ||
		!("requestMessageIds" in value) ||
		!Array.isArray(value.requestMessageIds) ||
		value.requestMessageIds.length === 0 ||
		value.requestMessageIds.some(
			(requestId) => typeof requestId !== "string" || requestId.length === 0,
		) ||
		new Set(value.requestMessageIds).size !== value.requestMessageIds.length
	) {
		throw new Error("invalid_input: Agent Wait requires unique non-empty Request identities");
	}
	return { requestMessageIds: [...value.requestMessageIds] };
}

function committedAgentWaitInput(options: {
	agentId: string;
	transcript: TranscriptInspection;
	toolCallId: string;
}): AgentWaitInput {
	const committed = resolveCommittedToolCall({
		agentId: options.agentId,
		transcript: options.transcript,
		toolCallId: options.toolCallId,
		toolName: "agent_wait",
	});
	return validateAgentWaitInput(committed.input);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	return keys.length === sortedExpected.length &&
		keys.every((key, index) => key === sortedExpected[index]);
}

function isToolCallPointer(value: unknown): value is ToolCallPointer {
	return isRecord(value) &&
		sameKeys(value, ["agentId", "entryId", "toolCallId"]) &&
		typeof value.agentId === "string" && value.agentId.length > 0 &&
		typeof value.entryId === "string" && value.entryId.length > 0 &&
		typeof value.toolCallId === "string" && value.toolCallId.length > 0;
}

function isEntryPointer(
	value: unknown,
): value is Readonly<{ agentId: string; entryId: string }> {
	return isRecord(value) &&
		sameKeys(value, ["agentId", "entryId"]) &&
		typeof value.agentId === "string" && value.agentId.length > 0 &&
		typeof value.entryId === "string" && value.entryId.length > 0;
}
