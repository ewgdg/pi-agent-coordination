import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";

import {
	AGENT_IDENTITY_CUSTOM_TYPE,
	MODERATOR_INPUT_CUSTOM_TYPE,
} from "./custom-entry-types.ts";

export { AGENT_IDENTITY_CUSTOM_TYPE } from "./custom-entry-types.ts";
const OWNER_LABEL = "owner";

export type OwnerIdentity = Readonly<{
	agentId: string;
	workflowId: string;
	directSpawnerAgentId: null;
	metadata: Readonly<{
		label: "owner";
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
	const matchingIdentityEntries = entries.filter(
		(entry) =>
			entry.type === "custom" &&
			entry.customType === AGENT_IDENTITY_CUSTOM_TYPE &&
			isRecord(entry.data) &&
			entry.data.agentId === sessionId,
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
	if (matchingIdentityEntries.length > 1) {
		throw new InvalidOwnerIdentityError("current Pi session has multiple Identity entries");
	}
	if (matchingIdentityEntries.length === 1) {
		const entry = matchingIdentityEntries[0];
		if (entry.type !== "custom") throw new Error("Identity entry narrowing failed");
		return validateOwnerIdentity(entry.data, sessionId);
	}
	if (
		!options?.allowCopiedCoordinationContext &&
		entries.some(
			(entry) =>
				(entry.type === "custom" &&
					entry.customType === AGENT_IDENTITY_CUSTOM_TYPE) ||
				(entry.type === "custom_message" &&
					entry.customType === MODERATOR_INPUT_CUSTOM_TYPE),
		)
	) {
		throw new InvalidOwnerIdentityError(
			"copied coordination bootstrap does not match the current Pi session",
		);
	}

	const identity: OwnerIdentity = {
		agentId: sessionId,
		workflowId: sessionId,
		directSpawnerAgentId: null,
		metadata: { label: OWNER_LABEL },
	};
	sessionManager.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, identity);
	return identity;
}

function validateOwnerIdentity(value: unknown, sessionId: string): OwnerIdentity {
	if (
		isRecord(value) &&
		(value.workflowId !== sessionId ||
			value.directSpawnerAgentId !== null ||
			"spawnSource" in value)
	) {
		throw new InvalidOwnerIdentityError("current Pi session is a child Agent");
	}
	const identity = requireExactRecord(value, [
		"agentId",
		"workflowId",
		"directSpawnerAgentId",
		"metadata",
	]);
	if (identity.agentId !== sessionId || identity.workflowId !== sessionId) {
		throw new InvalidOwnerIdentityError("current Pi session is a child Agent");
	}
	if (identity.directSpawnerAgentId !== null) {
		throw new InvalidOwnerIdentityError("Owner directSpawnerAgentId must be null");
	}
	const metadata = requireExactRecord(identity.metadata, ["label"]);
	if (metadata.label !== OWNER_LABEL) {
		throw new InvalidOwnerIdentityError('Owner label must be "owner"');
	}
	return {
		agentId: sessionId,
		workflowId: sessionId,
		directSpawnerAgentId: null,
		metadata: { label: OWNER_LABEL },
	};
}

function requireExactRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
	if (!isRecord(value)) throw new InvalidOwnerIdentityError("Identity data must be an object");
	const actualKeys = Object.keys(value).sort();
	const sortedExpectedKeys = [...expectedKeys].sort();
	if (
		actualKeys.length !== sortedExpectedKeys.length ||
		actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
	) {
		throw new InvalidOwnerIdentityError("Identity data has an invalid shape");
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
