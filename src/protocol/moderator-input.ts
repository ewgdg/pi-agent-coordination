import type {
	SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { isDeepStrictEqual } from "node:util";

import { resolveModeratorAgentMetadata } from "./agent-metadata.ts";
import type { ToolCallPointer } from "./identities.ts";
import { ProtocolInvariantError } from "./identities.ts";
import type { RuntimeConfigurationBaseline } from "./runtime-configuration.ts";
import { validateRuntimeConfigurationBaseline } from "./runtime-configuration.ts";
import {
	AGENT_IDENTITY_CUSTOM_TYPE,
	MODERATOR_INPUT_CUSTOM_TYPE,
} from "./custom-entry-types.ts";

export { MODERATOR_INPUT_CUSTOM_TYPE } from "./custom-entry-types.ts";

export const MAX_OBLIGATION_STALL_REQUEST_SOURCES = 16;

export type EntryPointer = Readonly<{
	agentId: string;
	entryId: string;
}>;

export type ModeratorIdentity = Readonly<{
	agentId: string;
	workflowId: string;
	directSpawnerAgentId: null;
	configuration: Readonly<{
		label: "moderator";
		description: string;
		baseline: RuntimeConfigurationBaseline;
	}>;
}>;

export function isModeratorIdentity(
	identity: Readonly<{
		agentId: string;
		workflowId: string;
		directSpawnerAgentId: string | null;
	}>,
): identity is ModeratorIdentity {
	return identity.agentId !== identity.workflowId &&
		identity.directSpawnerAgentId === null;
}

export type ObligationStallModeratorInput = Readonly<{
	trigger: Readonly<{
		kind: "obligation_stall";
		agentId: string;
		obligations: Readonly<{
			total: number;
			sources: readonly ToolCallPointer[];
		}>;
	}>;
	inspectedThrough: readonly EntryPointer[];
}>;

export type ModelVisibleModeratorInput = Readonly<{
	customType: typeof MODERATOR_INPUT_CUSTOM_TYPE;
	content: string;
	display: true;
	details: Readonly<{
		agentId: string;
		workflowId: string;
		configuration: ModeratorIdentity["configuration"];
	}>;
}>;

export function createModelVisibleModeratorInput(
	identity: ModeratorIdentity,
	input: ObligationStallModeratorInput,
): ModelVisibleModeratorInput {
	return {
		customType: MODERATOR_INPUT_CUSTOM_TYPE,
		content: JSON.stringify(input),
		display: true,
		details: {
			agentId: identity.agentId,
			workflowId: identity.workflowId,
			configuration: identity.configuration,
		},
	};
}

export function validateCommittedModeratorInput(options: {
	sessionManager: SessionManager;
	identity: ModeratorIdentity;
	input: ObligationStallModeratorInput;
}): void {
	const { sessionManager, identity, input } = options;
	if (sessionManager.getSessionId() !== identity.agentId) {
		throw new ProtocolInvariantError(
			"Moderator Input does not match its Pi session identity",
		);
	}
	const entries = sessionManager.getEntries();
	const inputs = entries.filter(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === MODERATOR_INPUT_CUSTOM_TYPE,
	);
	if (inputs.length !== 1) {
		throw new ProtocolInvariantError(
			`Moderator transcript contains ${inputs.length} Input entries`,
		);
	}
	const entry = inputs[0];
	if (
		!entry ||
		entry.type !== "custom_message" ||
		entries[0] !== entry ||
		entry.parentId !== null ||
		entry.display !== true
	) {
		throw new ProtocolInvariantError(
			"Moderator Input is not the model-visible transcript bootstrap entry",
		);
	}
	let committedInput: unknown;
	try {
		if (typeof entry.content !== "string") {
			throw new Error("non-text content");
		}
		committedInput = JSON.parse(entry.content);
	} catch {
		throw new ProtocolInvariantError("Moderator Input content is not valid JSON");
	}
	const expectedDetails = {
		agentId: identity.agentId,
		workflowId: identity.workflowId,
		configuration: identity.configuration,
	};
	if (
		!isDeepStrictEqual(committedInput, input) ||
		!isDeepStrictEqual(entry.details, expectedDetails)
	) {
		throw new ProtocolInvariantError(
			"Moderator Input contradicts its runtime-authored bootstrap",
		);
	}
}

export function validateColdModeratorInput(options: {
	sessionId: string;
	sessionCwd: string;
	entries: readonly SessionEntry[];
}): Readonly<{
	identity: ModeratorIdentity;
	input: ObligationStallModeratorInput;
}> {
	const ordinaryIdentities = options.entries.filter(
		(entry) => entry.type === "custom" &&
			entry.customType === AGENT_IDENTITY_CUSTOM_TYPE,
	);
	const inputs = options.entries.filter(
		(entry) => entry.type === "custom_message" &&
			entry.customType === MODERATOR_INPUT_CUSTOM_TYPE,
	);
	if (ordinaryIdentities.length > 0 || inputs.length !== 1) {
		throw new ProtocolInvariantError(
			"Moderator transcript must contain one Input and no ordinary Identity",
		);
	}
	const entry = inputs[0];
	if (
		!entry ||
		entry.type !== "custom_message" ||
		options.entries[0] !== entry ||
		entry.parentId !== null ||
		entry.display !== true ||
		typeof entry.content !== "string"
	) {
		throw new ProtocolInvariantError(
			"Moderator Input is not the model-visible transcript bootstrap entry",
		);
	}

	let inputValue: unknown;
	try {
		inputValue = JSON.parse(entry.content);
	} catch {
		throw new ProtocolInvariantError("Moderator Input content is not valid JSON");
	}
	const input = validateObligationStallInput(inputValue);
	const details = requireExactRecord(entry.details, [
		"agentId",
		"workflowId",
		"configuration",
	]);
	if (
		details.agentId !== options.sessionId ||
		!isIdentifier(details.workflowId) ||
		details.workflowId === options.sessionId
	) {
		throw new ProtocolInvariantError("Moderator Input Workflow relationship is invalid");
	}
	const configuration = requireExactRecord(details.configuration, [
		"label",
		"description",
		"baseline",
	]);
	const metadata = resolveModeratorAgentMetadata(input.trigger.kind);
	if (
		configuration.label !== metadata.label ||
		configuration.description !== metadata.description
	) {
		throw new ProtocolInvariantError("Moderator Input metadata is invalid");
	}
	let baseline: RuntimeConfigurationBaseline;
	try {
		baseline = validateRuntimeConfigurationBaseline(configuration.baseline);
	} catch (error) {
		throw new ProtocolInvariantError(
			error instanceof Error ? error.message : "Moderator Input baseline is invalid",
		);
	}
	if (baseline.cwd !== options.sessionCwd) {
		throw new ProtocolInvariantError(
			"Moderator baseline cwd does not match its Pi session cwd",
		);
	}
	return {
		identity: {
			agentId: options.sessionId,
			workflowId: details.workflowId,
			directSpawnerAgentId: null,
			configuration: { ...metadata, baseline },
		},
		input,
	};
}

function validateObligationStallInput(value: unknown): ObligationStallModeratorInput {
	const input = requireExactRecord(value, ["trigger", "inspectedThrough"]);
	const trigger = requireExactRecord(input.trigger, [
		"kind",
		"agentId",
		"obligations",
	]);
	if (trigger.kind !== "obligation_stall" || !isIdentifier(trigger.agentId)) {
		throw new ProtocolInvariantError("Moderator Input trigger is invalid");
	}
	const affectedAgentId = trigger.agentId;
	const obligations = requireExactRecord(trigger.obligations, ["total", "sources"]);
	if (
		!Number.isSafeInteger(obligations.total) ||
		(obligations.total as number) < 1 ||
		!Array.isArray(obligations.sources) ||
		obligations.sources.length < 1 ||
		obligations.sources.length > MAX_OBLIGATION_STALL_REQUEST_SOURCES ||
		obligations.sources.length > (obligations.total as number)
	) {
		throw new ProtocolInvariantError("Moderator Input obligations are invalid");
	}
	const sources = obligations.sources.map(validateToolCallPointer);
	if (new Set(sources.map(pointerKey)).size !== sources.length) {
		throw new ProtocolInvariantError("Moderator Input Request sources contain duplicates");
	}
	if (!Array.isArray(input.inspectedThrough) || input.inspectedThrough.length !== 1) {
		throw new ProtocolInvariantError("Moderator Input inspection watermarks are invalid");
	}
	const inspectedThrough = input.inspectedThrough.map((value) => {
		const pointer = requireExactRecord(value, ["agentId", "entryId"]);
		if (
			pointer.agentId !== affectedAgentId ||
			!isIdentifier(pointer.entryId)
		) {
			throw new ProtocolInvariantError("Moderator Input inspection watermark is invalid");
		}
		return { agentId: affectedAgentId, entryId: pointer.entryId };
	});
	return {
		trigger: {
			kind: "obligation_stall",
			agentId: affectedAgentId,
			obligations: {
				total: obligations.total as number,
				sources,
			},
		},
		inspectedThrough,
	};
}

function validateToolCallPointer(value: unknown): ToolCallPointer {
	const pointer = requireExactRecord(value, ["agentId", "entryId", "toolCallId"]);
	if (
		!isIdentifier(pointer.agentId) ||
		!isIdentifier(pointer.entryId) ||
		!isIdentifier(pointer.toolCallId)
	) {
		throw new ProtocolInvariantError("Moderator Input Request source is invalid");
	}
	return {
		agentId: pointer.agentId,
		entryId: pointer.entryId,
		toolCallId: pointer.toolCallId,
	};
}

function pointerKey(pointer: ToolCallPointer): string {
	return `${pointer.agentId}\0${pointer.entryId}\0${pointer.toolCallId}`;
}

function requireExactRecord(
	value: unknown,
	expectedKeys: readonly string[],
): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new ProtocolInvariantError("Moderator Input value must be an object");
	}
	const record = value as Record<string, unknown>;
	const actual = Object.keys(record).sort();
	const expected = [...expectedKeys].sort();
	if (
		actual.length !== expected.length ||
		actual.some((key, index) => key !== expected[index])
	) {
		throw new ProtocolInvariantError("Moderator Input value has an invalid shape");
	}
	return record;
}

function isIdentifier(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.includes("\0");
}
