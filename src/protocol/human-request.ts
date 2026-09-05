import { coordinationEntries } from "../transcript/retained-transcript.ts";
import { isDeepStrictEqual } from "node:util";

import type { TranscriptInspection } from "../transcript/agent-transcript.ts";

import {
	deriveHumanRequestIdentity,
	ProtocolInvariantError,
	resolveCommittedToolCall,
	type ToolCallPointer,
} from "./identities.ts";

export type HumanRequestInput = Readonly<{
	question: string;
}>;

export type HumanAnswer = Readonly<{
	requestId: string;
	answer: string;
}>;

export type HumanAnswerCandidate = HumanAnswer;

export type HumanRequest = Readonly<{
	requestId: string;
	requesterAgentId: string;
	source: ToolCallPointer;
	question: string;
}>;

export type HumanRequestResultInspection =
	| Readonly<{ state: "pending" }>
	| Readonly<{
		state: "answered";
		answer: HumanAnswer;
		resultEntryId: string;
	}>
	| Readonly<{
		state: "interrupted";
		resultEntryId: string;
	}>;

export function resolveCommittedHumanRequest(options: {
	agentId: string;
	transcript: TranscriptInspection;
	toolCallId: string;
	providedInput: HumanRequestInput;
}): HumanRequest {
	const committed = resolveCommittedToolCall({
		agentId: options.agentId,
		transcript: options.transcript,
		toolCallId: options.toolCallId,
		toolName: "ask_user_question",
	});
	const input = validateHumanRequestInput(committed.input);
	const provided = validateHumanRequestInput(
		options.providedInput as unknown as Record<string, unknown>,
	);
	if (!isDeepStrictEqual(input, provided)) {
		throw new Error("invariant_violation: Human Request input differs from its committed call");
	}
	return {
		requestId: deriveHumanRequestIdentity(committed.source),
		requesterAgentId: options.agentId,
		source: committed.source,
		question: input.question,
	};
}

export function validateHumanRequestInput(
	value: Record<string, unknown>,
): HumanRequestInput {
	if (!sameKeys(value, ["question"])) {
		throw new Error("invalid_input: Human Request input has an invalid shape");
	}
	return {
		question: requireNonBlank(value.question, "Human Request question"),
	};
}

export function validateHumanAnswer(
	requestId: string,
	value: unknown,
): HumanAnswer {
	if (!isRecord(value) || !sameKeys(value, ["answer", "requestId"])) {
		throw new Error(`invalid_input: Human Answer ${requestId} has an invalid shape`);
	}
	if (value.requestId !== requestId) {
		throw new Error(`invalid_correlation: Human Answer ${requestId} has invalid correlation`);
	}
	return {
		requestId,
		answer: requireNonBlank(value.answer, "Human Answer text"),
	};
}

export function inspectCommittedHumanRequestResult(options: {
	request: HumanRequest;
	transcript: TranscriptInspection;
}): HumanRequestResultInspection {
	const matches = coordinationEntries(options.transcript, options.request.requesterAgentId, `result:${options.request.source.toolCallId}`).filter(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === options.request.source.toolCallId,
	);
	if (matches.length > 1) {
		throw new ProtocolInvariantError(
			`Human Request ${options.request.requestId} has multiple native results`,
		);
	}
	const match = matches[0];
	if (!match || match.type !== "message" || match.message.role !== "toolResult") {
		return { state: "pending" };
	}
	if (match.message.toolName !== "ask_user_question") {
		throw new ProtocolInvariantError(
			`Human Request ${options.request.requestId} result names ${match.message.toolName}`,
		);
	}
	if (match.message.isError) {
		return { state: "interrupted", resultEntryId: match.id };
	}
	let answer: HumanAnswer;
	try {
		answer = validateHumanAnswer(options.request.requestId, match.message.details);
	} catch (error) {
		throw new ProtocolInvariantError(
			`Human Answer ${options.request.requestId} is invalid: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (
		match.message.content.length !== 1 ||
		match.message.content[0]?.type !== "text"
	) {
		throw new ProtocolInvariantError(
			`Human Answer ${options.request.requestId} content has an invalid shape`,
		);
	}
	let content: unknown;
	try {
		content = JSON.parse(match.message.content[0].text);
	} catch {
		throw new ProtocolInvariantError(
			`Human Answer ${options.request.requestId} content is not valid JSON`,
		);
	}
	if (!isDeepStrictEqual(content, answer)) {
		throw new ProtocolInvariantError(
			`Human Answer ${options.request.requestId} content differs from its details`,
		);
	}
	return { state: "answered", answer, resultEntryId: match.id };
}

function requireNonBlank(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`invalid_input: ${name} must not be blank`);
	}
	return value;
}

function sameKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value).sort();
	return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
