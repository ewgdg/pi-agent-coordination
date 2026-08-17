import type {
	AgentSessionRuntime,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";

import {
	AGENT_IDENTITY_CUSTOM_TYPE,
	MODERATOR_INPUT_CUSTOM_TYPE,
} from "./custom-entry-types.ts";
import { resolveOwnerAgentMetadata } from "./agent-metadata.ts";

export { AGENT_IDENTITY_CUSTOM_TYPE } from "./custom-entry-types.ts";

export type OwnerIdentity = Readonly<{
	agentId: string;
	workflowId: string;
	directSpawnerAgentId: null;
	metadata: Readonly<{
		label: "Owner";
		description: "Workflow Owner";
	}>;
}>;

export class InvalidOwnerIdentityError extends Error {
	constructor(message: string) {
		super(`Cannot bootstrap Workflow Owner: ${message}`);
		this.name = "InvalidOwnerIdentityError";
	}
}

export function adoptOrValidateOwnerIdentity(
	runtime: AgentSessionRuntime,
	options?: { allowCopiedCoordinationContext?: boolean },
): OwnerIdentity {
	const sessionManager = runtime.session.sessionManager;
	const sessionId = sessionManager.getSessionId();
	const entries = sessionManager.getEntries();
	const identityEntries = entries.filter(
		(entry): entry is Extract<SessionEntry, { type: "custom" }> =>
			entry.type === "custom" && entry.customType === AGENT_IDENTITY_CUSTOM_TYPE,
	);
	const matchingIdentityEntries = identityEntries.filter(
		(entry) => isRecord(entry.data) && entry.data.agentId === sessionId,
	);
	const matchingModeratorEntries = entries.filter(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === MODERATOR_INPUT_CUSTOM_TYPE &&
			isRecord(entry.details) &&
			entry.details.agentId === sessionId,
	);

	if (matchingModeratorEntries.length > 0) {
		throw new InvalidOwnerIdentityError("current Pi session is a Moderator");
	}

	const currentIdentity = matchingIdentityEntries.at(-1);
	if (currentIdentity) {
		if (isValidCurrentChildIdentity(currentIdentity.data, sessionId)) {
			throw new InvalidOwnerIdentityError("current Pi session is a child Agent");
		}
		const identity = createCanonicalOwnerIdentity(sessionId);
		if (!isCanonicalOwnerIdentity(currentIdentity.data, sessionId)) {
			// The current session is authoritative. Append a fresh cutoff so stale
			// Identity data, including child-shaped fork remnants, is historical only.
			sessionManager.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, identity);
		}
		return identity;
	}
	if (identityEntries.length > 0) {
		// Any Identity entry without a current-session ID may be the tail of an
		// interrupted fork. Continue with a fresh Owner bootstrap instead of
		// reclassifying the copied evidence.
		const identity = createCanonicalOwnerIdentity(sessionId);
		sessionManager.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, identity);
		return identity;
	}
	if (
		!options?.allowCopiedCoordinationContext &&
		entries.some(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === MODERATOR_INPUT_CUSTOM_TYPE,
		)
	) {
		throw new InvalidOwnerIdentityError(
			"copied coordination bootstrap does not match the current Pi session",
		);
	}

	const identity = createCanonicalOwnerIdentity(sessionId);
	sessionManager.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, identity);
	return identity;
}

function createCanonicalOwnerIdentity(sessionId: string): OwnerIdentity {
	return {
		agentId: sessionId,
		workflowId: sessionId,
		directSpawnerAgentId: null,
		metadata: resolveOwnerAgentMetadata(),
	};
}

function isCanonicalOwnerIdentity(value: unknown, sessionId: string): boolean {
	return isRecord(value) &&
		value.agentId === sessionId &&
		value.workflowId === sessionId &&
		value.directSpawnerAgentId === null &&
		!("spawnSource" in value);
}

function isValidCurrentChildIdentity(value: unknown, sessionId: string): boolean {
	return isValidChildIdentity(value) && value.agentId === sessionId;
}

function isValidChildIdentity(
	value: unknown,
): value is Record<string, unknown> & {
	agentId: string;
	workflowId: string;
	directSpawnerAgentId: string;
	spawnSource: Record<string, unknown>;
} {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"agentId",
			"workflowId",
			"directSpawnerAgentId",
			"spawnSource",
			"metadata",
		]) ||
		!isIdentifier(value.agentId) ||
		!isIdentifier(value.workflowId) ||
		value.workflowId === value.agentId ||
		!isIdentifier(value.directSpawnerAgentId) ||
		value.directSpawnerAgentId === value.agentId ||
		!isRecord(value.spawnSource) ||
		!hasExactKeys(value.spawnSource, ["agentId", "entryId", "toolCallId"]) ||
		value.spawnSource.agentId !== value.directSpawnerAgentId ||
		!isIdentifier(value.spawnSource.entryId) ||
		!isIdentifier(value.spawnSource.toolCallId)
	) {
		return false;
	}
	if (!isRecord(value.metadata)) return false;
	if (
		!hasExactKeys(
			value.metadata,
			value.metadata.description === undefined
				? ["label"]
				: ["label", "description"],
		) ||
		!isIdentifier(value.metadata.label) ||
		(value.metadata.description !== undefined &&
			!isIdentifier(value.metadata.description))
	) {
		return false;
	}
	return true;
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
	const actualKeys = Object.keys(value).sort();
	const sortedExpectedKeys = [...expectedKeys].sort();
	return actualKeys.length === sortedExpectedKeys.length &&
		actualKeys.every((key, index) => key === sortedExpectedKeys[index]);
}

function isIdentifier(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
