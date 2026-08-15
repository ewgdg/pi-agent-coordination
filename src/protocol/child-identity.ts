import type {
	SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { isDeepStrictEqual } from "node:util";

import { validateConversationForkHandoff } from "./conversation-fork.ts";
import { CONVERSATION_FORK_CUSTOM_TYPE } from "./custom-entry-types.ts";
import { AGENT_IDENTITY_CUSTOM_TYPE } from "./owner-identity.ts";
import type { ToolCallPointer } from "./identities.ts";
import { ProtocolInvariantError } from "./identities.ts";
import type { TranscriptInspection } from "../transcript/agent-transcript.ts";

export type ChildAgentIdentity = Readonly<{
	agentId: string;
	workflowId: string;
	directSpawnerAgentId: string;
	spawnSource: ToolCallPointer;
	metadata: Readonly<{
		label: string;
		description?: string;
	}>;
}>;

export function commitChildAgentIdentity(
	sessionManager: SessionManager,
	identity: ChildAgentIdentity,
	options?: { inheritedConversation?: boolean },
): void {
	if (sessionManager.getSessionId() !== identity.agentId) {
		throw new Error("Child Identity Agent ID does not match its Pi session");
	}
	const entries = sessionManager.getEntries();
	if (!options?.inheritedConversation && entries.length !== 0) {
		throw new Error("Child transcript is not empty before Identity commit");
	}
	if (
		entries.some(
			(entry) => entry.type === "custom" &&
				entry.customType === AGENT_IDENTITY_CUSTOM_TYPE &&
				isRecord(entry.data) && entry.data.agentId === identity.agentId,
		)
	) {
		throw new Error("Child transcript already contains its current Identity");
	}
	sessionManager.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, identity);
}

export function validateCommittedChildIdentity(
	transcript: TranscriptInspection,
	expected: ChildAgentIdentity,
	options?: { inheritedConversation?: boolean },
): void {
	if (transcript.sessionId !== expected.agentId) {
		throw new ProtocolInvariantError("child Identity does not match its Pi session identity");
	}
	const ordinaryIdentities = transcript.entries.filter(
		(entry) => entry.type === "custom" && entry.customType === AGENT_IDENTITY_CUSTOM_TYPE,
	);
	const identities = options?.inheritedConversation
		? ordinaryIdentities.filter(
			(entry) => entry.type === "custom" &&
				isRecord(entry.data) && entry.data.agentId === expected.agentId,
		)
		: ordinaryIdentities;
	if (identities.length !== 1) {
		const identityKind = options?.inheritedConversation ? "current ordinary" : "ordinary";
		throw new ProtocolInvariantError(
			`child transcript contains ${identities.length} ${identityKind} Identity entries`,
		);
	}
	const identity = identities[0];
	if (!identity || identity.type !== "custom" || !isDeepStrictEqual(identity.data, expected)) {
		throw new ProtocolInvariantError("child Identity contradicts its Agent Spawn source");
	}
}

export function validateColdChildIdentity(options: {
	sessionId: string;
	entries: readonly SessionEntry[];
}): ChildAgentIdentity {
	const identityEntries = options.entries.filter(
		(entry) => entry.type === "custom" && entry.customType === AGENT_IDENTITY_CUSTOM_TYPE &&
			isRecord(entry.data) && entry.data.agentId === options.sessionId,
	);
	if (identityEntries.length !== 1) {
		throw new ProtocolInvariantError(
			`child transcript contains ${identityEntries.length} current ordinary Identity entries`,
		);
	}
	const identityEntry = identityEntries[0];
	if (!identityEntry || identityEntry.type !== "custom") {
		throw new Error("Child Identity entry narrowing failed");
	}
	const identity = requireExactRecord(identityEntry.data, [
		"agentId",
		"workflowId",
		"directSpawnerAgentId",
		"spawnSource",
		"metadata",
	]);
	if (identity.agentId !== options.sessionId) {
		throw new ProtocolInvariantError("child Identity does not match its Pi session identity");
	}
	if (
		!isIdentifier(identity.workflowId) ||
		!isIdentifier(identity.directSpawnerAgentId) ||
		identity.directSpawnerAgentId === options.sessionId
	) {
		throw new ProtocolInvariantError("child Identity authority is invalid");
	}
	const spawnSource = requireExactRecord(identity.spawnSource, [
		"agentId",
		"entryId",
		"toolCallId",
	]);
	if (
		spawnSource.agentId !== identity.directSpawnerAgentId ||
		!isIdentifier(spawnSource.entryId) ||
		!isIdentifier(spawnSource.toolCallId)
	) {
		throw new ProtocolInvariantError("child Identity spawn source is invalid");
	}
	const metadata = requireExactRecord(identity.metadata, [
		"label",
		...(isRecord(identity.metadata) && identity.metadata.description !== undefined
			? ["description"]
			: []),
	]);
	if (!isIdentifier(metadata.label)) {
		throw new ProtocolInvariantError("child Identity label is invalid");
	}
	if (metadata.description !== undefined && !isIdentifier(metadata.description)) {
		throw new ProtocolInvariantError("child Identity description is invalid");
	}
	return {
		agentId: options.sessionId,
		workflowId: identity.workflowId,
		directSpawnerAgentId: identity.directSpawnerAgentId,
		spawnSource: {
			agentId: spawnSource.agentId,
			entryId: spawnSource.entryId,
			toolCallId: spawnSource.toolCallId,
		},
		metadata: {
			label: metadata.label,
			...(metadata.description === undefined
				? {}
				: { description: metadata.description }),
		},
	};
}

export function validateColdChildConversationMode(options: {
	entries: readonly SessionEntry[];
	identity: ChildAgentIdentity;
	inheritedConversation: boolean;
}): void {
	const identityIndex = options.entries.findIndex(
		(entry) => entry.type === "custom" &&
			entry.customType === AGENT_IDENTITY_CUSTOM_TYPE &&
			isRecord(entry.data) && entry.data.agentId === options.identity.agentId,
	);
	const identityEntry = options.entries[identityIndex];
	if (!identityEntry || identityEntry.type !== "custom") {
		throw new ProtocolInvariantError("child transcript has no current Identity cutoff");
	}
	const latestOrdinaryIdentityIndex = options.entries.findLastIndex(
		(entry) => entry.type === "custom" && entry.customType === AGENT_IDENTITY_CUSTOM_TYPE,
	);
	if (latestOrdinaryIdentityIndex !== identityIndex) {
		throw new ProtocolInvariantError("child Identity is not the latest ordinary Identity");
	}
	const currentHandoffs = options.entries.slice(identityIndex + 1).filter(
		(entry) => entry.type === "custom_message" &&
			entry.customType === CONVERSATION_FORK_CUSTOM_TYPE,
	);
	const expectedHandoffCount = options.inheritedConversation ? 1 : 0;
	if (currentHandoffs.length !== expectedHandoffCount) {
		throw new ProtocolInvariantError(
			`child transcript contains ${currentHandoffs.length} current conversation fork handoffs`,
		);
	}
	if (!options.inheritedConversation) {
		if (identityIndex !== 0 || identityEntry.parentId !== null) {
			throw new ProtocolInvariantError("child Identity is not the transcript bootstrap entry");
		}
		return;
	}
	const inheritedTail = options.entries[identityIndex - 1];
	if (identityIndex === 0 || !inheritedTail || identityEntry.parentId !== inheritedTail.id) {
		throw new ProtocolInvariantError(
			"conversation fork Identity does not follow its inherited context",
		);
	}
	const handoff = options.entries[identityIndex + 1];
	if (!handoff || handoff.parentId !== identityEntry.id) {
		throw new ProtocolInvariantError(
			"conversation fork handoff does not follow its child Identity",
		);
	}
	validateConversationForkHandoff(handoff, options.identity);
}

function requireExactRecord(
	value: unknown,
	expectedKeys: readonly string[],
): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new ProtocolInvariantError("child Identity data must be an object");
	}
	const actual = Object.keys(value).sort();
	const expected = [...expectedKeys].sort();
	if (
		actual.length !== expected.length ||
		actual.some((key, index) => key !== expected[index])
	) {
		throw new ProtocolInvariantError("child Identity data has an invalid shape");
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.includes("\0");
}
