import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { isDeepStrictEqual } from "node:util";

import {
	AGENT_IDENTITY_CUSTOM_TYPE,
	type RuntimeConfigurationBaseline,
} from "./owner-identity.ts";
import type { ToolCallPointer } from "./identities.ts";
import { ProtocolInvariantError } from "./identities.ts";

export type ChildAgentIdentity = Readonly<{
	agentId: string;
	workflowId: string;
	directSpawnerAgentId: string;
	spawnSource: ToolCallPointer;
	configuration: Readonly<{
		label: string;
		description?: string;
		baseline: RuntimeConfigurationBaseline;
	}>;
}>;

export function commitChildAgentIdentity(
	sessionManager: SessionManager,
	identity: ChildAgentIdentity,
): void {
	if (sessionManager.getSessionId() !== identity.agentId) {
		throw new Error("Child Identity Agent ID does not match its Pi session");
	}
	if (sessionManager.getEntries().length !== 0) {
		throw new Error("Child transcript is not empty before Identity commit");
	}
	sessionManager.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, identity);
}

export function validateCommittedChildIdentity(
	sessionManager: SessionManager,
	expected: ChildAgentIdentity,
): void {
	if (sessionManager.getSessionId() !== expected.agentId) {
		throw new ProtocolInvariantError("child Identity does not match its Pi session identity");
	}
	const identities = sessionManager
		.getEntries()
		.filter(
			(entry) => entry.type === "custom" && entry.customType === AGENT_IDENTITY_CUSTOM_TYPE,
		);
	if (identities.length !== 1) {
		throw new ProtocolInvariantError(
			`child transcript contains ${identities.length} ordinary Identity entries`,
		);
	}
	const identity = identities[0];
	if (!identity || identity.type !== "custom" || !isDeepStrictEqual(identity.data, expected)) {
		throw new ProtocolInvariantError("child Identity contradicts its Agent Spawn source");
	}
}
