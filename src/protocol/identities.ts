import { createHash } from "node:crypto";

import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

import { AGENT_IDENTITY_CUSTOM_TYPE } from "./owner-identity.ts";

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
	sessionManager: SessionManager;
	toolCallId: string;
}): { source: ToolCallPointer; input: Record<string, unknown> } {
	return resolveCommittedToolCall({ ...options, toolName: "agent_spawn" });
}

export function resolveCommittedToolCall(options: {
	agentId: string;
	sessionManager: SessionManager;
	toolCallId: string;
	toolName: string;
}): { source: ToolCallPointer; input: Record<string, unknown> } {
	const { agentId, sessionManager, toolCallId, toolName } = options;
	const entries = currentCoordinationScope(sessionManager, agentId);
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

export function currentCoordinationScope(
	sessionManager: SessionManager,
	agentId: string,
): SessionEntry[] {
	const entries = sessionManager.getEntries();
	const bootstrapIndex = entries.findIndex(
		(entry) =>
			entry.type === "custom" &&
			entry.customType === AGENT_IDENTITY_CUSTOM_TYPE &&
			isRecord(entry.data) &&
			entry.data.agentId === agentId,
	);
	if (bootstrapIndex < 0) {
		throw new ProtocolInvariantError(`Agent ${agentId} has no current Identity`);
	}
	return entries.slice(bootstrapIndex + 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
