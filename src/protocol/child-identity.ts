import type {
	SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { isDeepStrictEqual } from "node:util";

import {
	AGENT_IDENTITY_CUSTOM_TYPE,
	type RuntimeConfigurationBaseline,
} from "./owner-identity.ts";
import type { ToolCallPointer } from "./identities.ts";
import { ProtocolInvariantError } from "./identities.ts";
import { validateRuntimeConfigurationBaseline } from "./runtime-configuration.ts";
import type { TranscriptInspection } from "../transcript/agent-transcript.ts";

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
	transcript: TranscriptInspection,
	expected: ChildAgentIdentity,
): void {
	if (transcript.sessionId !== expected.agentId) {
		throw new ProtocolInvariantError("child Identity does not match its Pi session identity");
	}
	const identities = transcript.entries.filter(
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

export function validateColdChildIdentity(options: {
	sessionId: string;
	sessionCwd: string;
	entries: readonly SessionEntry[];
}): ChildAgentIdentity {
	const identityEntries = options.entries.filter(
		(entry) => entry.type === "custom" && entry.customType === AGENT_IDENTITY_CUSTOM_TYPE,
	);
	if (identityEntries.length !== 1) {
		throw new ProtocolInvariantError(
			`child transcript contains ${identityEntries.length} ordinary Identity entries`,
		);
	}
	const identityEntry = identityEntries[0];
	if (!identityEntry || identityEntry.type !== "custom") {
		throw new Error("Child Identity entry narrowing failed");
	}
	if (options.entries[0] !== identityEntry || identityEntry.parentId !== null) {
		throw new ProtocolInvariantError("child Identity is not the transcript bootstrap entry");
	}
	const identity = requireExactRecord(identityEntry.data, [
		"agentId",
		"workflowId",
		"directSpawnerAgentId",
		"spawnSource",
		"configuration",
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
	const configuration = requireExactRecord(identity.configuration, [
		"label",
		...(isRecord(identity.configuration) && identity.configuration.description !== undefined
			? ["description"]
			: []),
		"baseline",
	]);
	if (!isIdentifier(configuration.label)) {
		throw new ProtocolInvariantError("child Identity label is invalid");
	}
	if (
		configuration.description !== undefined &&
		!isIdentifier(configuration.description)
	) {
		throw new ProtocolInvariantError("child Identity description is invalid");
	}
	let baseline;
	try {
		baseline = validateRuntimeConfigurationBaseline(configuration.baseline);
	} catch (error) {
		throw new ProtocolInvariantError(
			error instanceof Error ? error.message : "child Identity baseline is invalid",
		);
	}
	if (baseline.cwd !== options.sessionCwd) {
		throw new ProtocolInvariantError("child baseline cwd does not match its Pi session cwd");
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
		configuration: {
			label: configuration.label,
			...(configuration.description === undefined
				? {}
				: { description: configuration.description }),
			baseline,
		},
	};
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
