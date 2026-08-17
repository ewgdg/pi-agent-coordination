import { createHash } from "node:crypto";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type { TranscriptInspection } from "../transcript/agent-transcript.ts";

import {
	AGENT_IDENTITY_CUSTOM_TYPE,
	MODERATOR_INPUT_CUSTOM_TYPE,
} from "./custom-entry-types.ts";

const IDENTITY_PREFIX = "agent-coordination";

export type ToolCallPointer = Readonly<{
	agentId: string;
	entryId: string;
	toolCallId: string;
}>;

export class ProtocolInvariantError extends Error {
	constructor(message: string) {
		super(`invariant_violation: ${message}`);
		this.name = "ProtocolInvariantError";
	}
}

export function resolveCommittedSpawnSource(options: {
	agentId: string;
	transcript: TranscriptInspection;
	toolCallId: string;
}): { source: ToolCallPointer; input: Record<string, unknown> } {
	return resolveCommittedToolCall({ ...options, toolName: "agent_spawn" });
}

export function resolveCommittedToolCall(options: {
	agentId: string;
	transcript: TranscriptInspection;
	toolCallId: string;
	toolName: string;
}): { source: ToolCallPointer; input: Record<string, unknown> } {
	const { agentId, transcript, toolCallId, toolName } = options;
	const entries = currentCoordinationScope(transcript, agentId);
	const matches: Array<{ entry: SessionEntry; input: Record<string, unknown> }> = [];

	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const part of entry.message.content) {
			if (part.type !== "toolCall" || part.id !== toolCallId) continue;
			if (part.name !== toolName) {
				throw new ProtocolInvariantError(
					`tool call ${toolCallId} is ${part.name}, not ${toolName}`,
				);
			}
			matches.push({ entry, input: part.arguments });
		}
	}

	if (matches.length !== 1) {
		throw new ProtocolInvariantError(
			`expected one committed ${toolName} source for ${toolCallId}, found ${matches.length}`,
		);
	}
	const match = matches[0];
	if (!match) throw new Error("Tool call source narrowing failed");
	return {
		source: { agentId, entryId: match.entry.id, toolCallId },
		input: match.input,
	};
}

export function compareCommittedToolCallOrder(
	transcript: TranscriptInspection,
	left: ToolCallPointer,
	right: ToolCallPointer,
): number {
	if (left.agentId !== right.agentId || left.agentId !== transcript.sessionId) {
		throw new ProtocolInvariantError("tool call order comparison crosses Agent identities");
	}
	const leftEntry = transcript.entries.findIndex((entry) => entry.id === left.entryId);
	const rightEntry = transcript.entries.findIndex((entry) => entry.id === right.entryId);
	if (leftEntry < 0 || rightEntry < 0) {
		throw new ProtocolInvariantError("tool call order comparison has unavailable evidence");
	}
	if (leftEntry !== rightEntry) return leftEntry - rightEntry;
	const entry = transcript.entries[leftEntry];
	if (!entry || entry.type !== "message" || entry.message.role !== "assistant") {
		throw new ProtocolInvariantError("tool call order comparison has no assistant source");
	}
	const message = entry.message;
	const callIndex = (toolCallId: string) => message.content.findIndex(
		(part) => part.type === "toolCall" && part.id === toolCallId,
	);
	const leftCall = callIndex(left.toolCallId);
	const rightCall = callIndex(right.toolCallId);
	if (leftCall < 0 || rightCall < 0) {
		throw new ProtocolInvariantError("tool call order comparison has unavailable calls");
	}
	return leftCall - rightCall;
}

export function deriveMessageIdentity(source: ToolCallPointer): string {
	return deriveProtocolIdentity("message", source);
}

export function deriveHumanRequestIdentity(source: ToolCallPointer): string {
	return deriveProtocolIdentity("human_request", source);
}

function deriveProtocolIdentity(
	kind: "message" | "human_request",
	source: ToolCallPointer,
): string {
	for (const [name, value] of Object.entries(source)) {
		if (value.length === 0 || value.includes("\0")) {
			throw new ProtocolInvariantError(`${name} is not a valid identity constituent`);
		}
	}
	return createHash("sha256")
		.update(
			[
				IDENTITY_PREFIX,
				kind,
				source.agentId,
				source.entryId,
				source.toolCallId,
			].join("\0"),
			"utf8",
		)
		.digest("base64url");
}

export function sameToolCallPointer(
	left: ToolCallPointer,
	right: ToolCallPointer,
): boolean {
	return (
		left.agentId === right.agentId &&
		left.entryId === right.entryId &&
		left.toolCallId === right.toolCallId
	);
}

export function toolCallPointerKey(pointer: ToolCallPointer): string {
	return JSON.stringify([
		pointer.agentId,
		pointer.entryId,
		pointer.toolCallId,
	]);
}

export function currentCoordinationScope(
	transcript: TranscriptInspection,
	agentId: string,
): readonly SessionEntry[] {
	const entries = transcript.entries;
	// Self-healing may append a canonical Identity after stale evidence; the
	// latest matching bootstrap is the current coordination cutoff.
	const bootstrapIndex = entries.findLastIndex(
		(entry) =>
			(entry.type === "custom" &&
				entry.customType === AGENT_IDENTITY_CUSTOM_TYPE &&
				isRecord(entry.data) &&
				entry.data.agentId === agentId) ||
			(entry.type === "custom_message" &&
				entry.customType === MODERATOR_INPUT_CUSTOM_TYPE &&
				isRecord(entry.details) &&
				entry.details.agentId === agentId),
	);
	if (bootstrapIndex < 0) {
		throw new ProtocolInvariantError(`Agent ${agentId} has no current Identity`);
	}
	return entries.slice(bootstrapIndex + 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
