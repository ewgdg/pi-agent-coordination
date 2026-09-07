import { indexedState, coordinationEntries } from "../transcript/retained-transcript.ts";
import { allocateWorkflowId } from "./workflow-ids.ts";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type { TranscriptInspection } from "../transcript/agent-transcript.ts";


export type ToolCallPointer = Readonly<{
	workflowId: string;
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
	const entries = coordinationEntries(transcript, agentId, `call:${toolCallId}`);
	return indexedState(transcript).memo(
		resolveCommittedToolCall,
		`${agentId}\0${toolName}\0${toolCallId}`,
		entries.length,
		() => {
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
				source: {
				workflowId: workflowOf(transcript, agentId), agentId, entryId: match.entry.id, toolCallId },
				input: match.input,
			};
		},
	);
}

export function compareCommittedToolCallOrder(
	transcript: TranscriptInspection,
	left: ToolCallPointer,
	right: ToolCallPointer,
): number {
	if (
		left.agentId !== right.agentId ||
		left.workflowId !== workflowOf(transcript, left.agentId) ||
		left.workflowId !== right.workflowId
	) {
		throw new ProtocolInvariantError("tool call order comparison crosses Agent identities");
	}
	const leftEntry = (indexedState(transcript).positions.get(left.entryId) ?? -1);
	const rightEntry = (indexedState(transcript).positions.get(right.entryId) ?? -1);
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

export function resolveMessageIdentity(source: ToolCallPointer): string {
	if (!isToolCallPointer(source)) throw new ProtocolInvariantError("Message source is invalid");
	return allocateWorkflowId({ workflowId: source.workflowId, domain: "m", source: toolCallPointerKey(source) });
}

export function workflowOf(transcript: TranscriptInspection, agentId: string): string {
	const workflowId = indexedState(transcript).workflowByAgent.get(agentId);
	if (workflowId !== undefined) return workflowId;
	throw new ProtocolInvariantError(`Agent ${agentId} has no Workflow identity`);
}

export function isToolCallPointer(value: unknown): value is ToolCallPointer {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const keys = Object.keys(value);
	return keys.length === 4 && ["workflowId", "agentId", "entryId", "toolCallId"].every((key) => {
		const field = (value as Record<string, unknown>)[key];
		return typeof field === "string" && field.length > 0 && !field.includes("\0");
	});
}

export function sameToolCallPointer(
	left: ToolCallPointer,
	right: ToolCallPointer,
): boolean {
	return (
		left.workflowId === right.workflowId &&
		left.agentId === right.agentId &&
		left.entryId === right.entryId &&
		left.toolCallId === right.toolCallId
	);
}

export function toolCallPointerKey(pointer: ToolCallPointer): string {
	return JSON.stringify([
		pointer.workflowId,
		pointer.agentId,
		pointer.entryId,
		pointer.toolCallId,
	]);
}

export function currentCoordinationScope(
	transcript: TranscriptInspection,
	agentId: string,
): readonly SessionEntry[] {
	return indexedState(transcript).scope(agentId);
}
