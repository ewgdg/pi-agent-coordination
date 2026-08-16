import { isDeepStrictEqual } from "node:util";

import type { TranscriptInspection } from "../transcript/agent-transcript.ts";
import {
	compareCommittedToolCallOrder,
	currentCoordinationScope,
	deriveMessageIdentity,
	ProtocolInvariantError,
	resolveCommittedToolCall,
	type ToolCallPointer,
} from "./identities.ts";

export type AgentWaitInput = Readonly<Record<never, never>>;

export type AgentWaitProgress = Readonly<{
	waitingFor: readonly Readonly<{
		requestMessageId: string;
		responderAgentId: string;
	}>[];
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

export type CompletedAgentWaitResult = Readonly<{
	answers: readonly AgentWaitAnswer[];
}>;

export type AgentWaitResult =
	| CompletedAgentWaitResult
	| Readonly<{ disposition: "preempted" }>;

export type AgentWaitResultInspection =
	| Readonly<{ state: "pending" }>
	| Readonly<{ state: "interrupted"; resultEntryId: string }>
	| Readonly<{ state: "preempted"; resultEntryId: string }>
	| Readonly<{
		state: "completed";
		result: CompletedAgentWaitResult;
		resultEntryId: string;
	}>;

export function resolveCommittedAgentWaitCall(options: {
	agentId: string;
	transcript: TranscriptInspection;
	toolCallId: string;
	providedInput: AgentWaitInput;
}): Readonly<{ source: ToolCallPointer; input: AgentWaitInput }> {
	const committed = committedAgentWaitCall(options);
	const input = committed.input;
	const provided = validateAgentWaitInput(options.providedInput);
	if (!isDeepStrictEqual(input, provided)) {
		throw new Error("invariant_violation: Agent Wait input differs from its committed call");
	}
	return { source: committed.source, input };
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
	const result = validateAgentWaitResult(match.message.details);
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
	const call = committedAgentWaitCall(options);
	if ("disposition" in result) {
		return { state: "preempted", resultEntryId: match.id };
	}
	// The parameterless call carries no identities. Its native result durably
	// materializes the coordinator's live snapshot, so reinspection verifies that
	// every slot is caller-authored before the Wait and remains in source order.
	const requestSources = result.answers.map(({ requestMessageId }) =>
		findCallerRequestSource({
			agentId: options.agentId,
			transcript: options.transcript,
			requestMessageId,
		})
	);
	for (let index = 0; index < requestSources.length; index += 1) {
		const source = requestSources[index]!;
		if (
			compareCommittedToolCallOrder(options.transcript, source, call.source) >= 0 ||
			(index > 0 && compareCommittedToolCallOrder(
				options.transcript,
				requestSources[index - 1]!,
				source,
			) >= 0)
		) {
			throw new ProtocolInvariantError(
				"Agent Wait result does not preserve its outstanding Request snapshot order",
			);
		}
	}
	return { state: "completed", result, resultEntryId: match.id };
}

export function validateAgentWaitResult(value: unknown): AgentWaitResult {
	if (
		isRecord(value) &&
		sameKeys(value, ["disposition"]) &&
		value.disposition === "preempted"
	) return { disposition: "preempted" };
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
		Object.keys(value).length !== 0
	) {
		throw new Error("invalid_input: Agent Wait does not accept parameters");
	}
	return {};
}

function committedAgentWaitCall(options: {
	agentId: string;
	transcript: TranscriptInspection;
	toolCallId: string;
}): Readonly<{ source: ToolCallPointer; input: AgentWaitInput }> {
	const committed = resolveCommittedToolCall({
		agentId: options.agentId,
		transcript: options.transcript,
		toolCallId: options.toolCallId,
		toolName: "agent_wait",
	});
	return { source: committed.source, input: validateAgentWaitInput(committed.input) };
}

function findCallerRequestSource(options: {
	agentId: string;
	transcript: TranscriptInspection;
	requestMessageId: string;
}): ToolCallPointer {
	const matches: ToolCallPointer[] = [];
	for (const entry of currentCoordinationScope(options.transcript, options.agentId)) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const part of entry.message.content) {
			if (
				part.type !== "toolCall" ||
				(part.name !== "agent_spawn" &&
					(part.name !== "agent_message" || part.arguments.operation !== "request"))
			) continue;
			const source = {
				agentId: options.agentId,
				entryId: entry.id,
				toolCallId: part.id,
			};
			if (deriveMessageIdentity(source) === options.requestMessageId) matches.push(source);
		}
	}
	if (matches.length !== 1) {
		throw new ProtocolInvariantError(
			`Agent Wait result Request ${options.requestMessageId} has ${matches.length} caller sources`,
		);
	}
	return matches[0]!;
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
