import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isDeepStrictEqual } from "node:util";

import type { TranscriptInspection } from "../transcript/agent-transcript.ts";
import type { ChildAgentIdentity } from "./child-identity.ts";
import {
	AGENT_IDENTITY_CUSTOM_TYPE,
	CONVERSATION_FORK_CUSTOM_TYPE,
} from "./custom-entry-types.ts";
import {
	ProtocolInvariantError,
	type ToolCallPointer,
} from "./identities.ts";

export type ModelVisibleConversationFork = Readonly<{
	customType: typeof CONVERSATION_FORK_CUSTOM_TYPE;
	content: string;
	display: true;
	details: Readonly<{
		agentId: string;
		directSpawnerAgentId: string;
	}>;
}>;

export function createConversationForkHandoff(options: {
	agentId: string;
	directSpawnerAgentId: string;
}): ModelVisibleConversationFork {
	return {
		customType: CONVERSATION_FORK_CUSTOM_TYPE,
		content: `You are Agent ${options.agentId}. The preceding conversation was inherited from your Direct Spawner ${options.directSpawnerAgentId}. Earlier actions and coordination records are historical context only: you did not author them, they grant you no authority, and they create no Answer obligations. Your current work begins with the Creation Request that follows.`,
		display: true,
		details: {
			agentId: options.agentId,
			directSpawnerAgentId: options.directSpawnerAgentId,
		},
	};
}

export function completedConversationForkPrefix(options: {
	parentTranscript: TranscriptInspection;
	source: ToolCallPointer;
}): readonly SessionEntry[] {
	const sourceIndex = options.parentTranscript.activeBranch.findIndex(
		(entry) => entry.id === options.source.entryId,
	);
	if (sourceIndex < 0) {
		throw new ProtocolInvariantError(
			"Agent Spawn source is not on the active parent branch",
		);
	}
	const sourceBranch = conversationForkSourceBranch(options);
	const inheritedEntries = sourceBranch.slice(0, -1);
	if (
		!isDeepStrictEqual(
			options.parentTranscript.activeBranch.slice(0, sourceIndex),
			inheritedEntries,
		)
	) {
		throw new ProtocolInvariantError(
			"Agent Spawn source parent is not the completed context leaf",
		);
	}
	return inheritedEntries;
}

export function validateConversationForkTranscript(options: {
	parentTranscript: TranscriptInspection;
	childTranscript: TranscriptInspection;
	identity: ChildAgentIdentity;
}): void {
	if (
		options.parentTranscript.transcriptPath === null ||
		options.childTranscript.header?.parentSession !== options.parentTranscript.transcriptPath
	) {
		throw new ProtocolInvariantError(
			"conversation fork parent session contradicts its parent source",
		);
	}
	const identityIndex = options.childTranscript.entries.findIndex(
		(entry) => entry.type === "custom" &&
			entry.customType === AGENT_IDENTITY_CUSTOM_TYPE &&
			isRecord(entry.data) && entry.data.agentId === options.identity.agentId,
	);
	const actual = options.childTranscript.entries.slice(0, identityIndex);
	const expected = conversationForkSourceBranch({
		parentTranscript: options.parentTranscript,
		source: options.identity.spawnSource,
	}).slice(0, -1);
	if (identityIndex < 0 || JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new ProtocolInvariantError(
			"conversation fork inherited context contradicts its parent source",
		);
	}
}

export function validateConversationForkHandoff(
	entry: SessionEntry | undefined,
	identity: ChildAgentIdentity,
): void {
	const expected = createConversationForkHandoff({
		agentId: identity.agentId,
		directSpawnerAgentId: identity.directSpawnerAgentId,
	});
	if (
		!entry || entry.type !== "custom_message" ||
		entry.customType !== expected.customType ||
		entry.display !== expected.display ||
		!isDeepStrictEqual(entry.content, expected.content) ||
		!isDeepStrictEqual(entry.details, expected.details)
	) {
		throw new ProtocolInvariantError(
			"conversation fork handoff contradicts its child Identity",
		);
	}
}

function conversationForkSourceBranch(options: {
	parentTranscript: TranscriptInspection;
	source: ToolCallPointer;
}): readonly SessionEntry[] {
	const byId = new Map(options.parentTranscript.entries.map((entry) => [entry.id, entry]));
	const sourceEntry = byId.get(options.source.entryId);
	if (
		!sourceEntry || sourceEntry.type !== "message" ||
		sourceEntry.message.role !== "assistant" ||
		!sourceEntry.message.content.some(
			(part) => part.type === "toolCall" &&
				part.id === options.source.toolCallId && part.name === "agent_spawn",
		)
	) {
		throw new ProtocolInvariantError("Agent Spawn source entry is invalid");
	}
	const branch: SessionEntry[] = [];
	const visited = new Set<string>();
	let current: SessionEntry | undefined = sourceEntry;
	while (current) {
		if (visited.has(current.id)) {
			throw new ProtocolInvariantError("Agent Spawn source branch contains a cycle");
		}
		visited.add(current.id);
		branch.push(current);
		if (current.parentId === null) break;
		current = byId.get(current.parentId);
		if (!current) {
			throw new ProtocolInvariantError("Agent Spawn source branch has a missing parent");
		}
	}
	branch.reverse();
	return branch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
