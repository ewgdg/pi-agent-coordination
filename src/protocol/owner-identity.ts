import type {
	AgentSessionRuntime,
	SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { isAbsolute } from "node:path";

import {
	isRuntimeThinkingLevel,
	type ModelReference,
	type RuntimeConfigurationBaseline,
} from "./runtime-configuration.ts";

export type { ModelReference, RuntimeConfigurationBaseline } from "./runtime-configuration.ts";

export const AGENT_IDENTITY_CUSTOM_TYPE = "agent-coordination.identity";
const MODERATOR_INPUT_CUSTOM_TYPE = "agent-coordination.moderator-input";
const OWNER_LABEL = "owner";

export type OwnerIdentity = Readonly<{
	agentId: string;
	workflowId: string;
	directSpawnerAgentId: null;
	configuration: Readonly<{
		label: "owner";
		baseline: RuntimeConfigurationBaseline;
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
	entryModulePath: string,
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
		const identity = validateOwnerIdentity(entry.data, sessionId, sessionManager);
		validateCurrentScope(entries, entry);
		return identity;
	}

	const identity = createOwnerIdentity(runtime, entryModulePath);
	sessionManager.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, identity);
	return identity;
}

function createOwnerIdentity(runtime: AgentSessionRuntime, entryModulePath: string): OwnerIdentity {
	const session = runtime.session;
	const agentId = session.sessionManager.getSessionId();
	const model = session.model;
	if (!model) throw new InvalidOwnerIdentityError("AgentConfiguration.baseline.model is unavailable");

	const thinking = session.thinkingLevel;
	if (!isRuntimeThinkingLevel(thinking)) {
		throw new InvalidOwnerIdentityError("AgentConfiguration.baseline.thinking is invalid");
	}
	const resources = runtime.services.resourceLoader;
	const skills = resources.getSkills().skills.map(({ name }) => name);
	const extensions = resources
		.getExtensions()
		.extensions.filter(
			(extension) =>
				extension.resolvedPath !== entryModulePath &&
				extension.path !== "<inline:pi-agent-coordination>",
		)
		.map(({ resolvedPath }) => resolvedPath);

	return {
		agentId,
		workflowId: agentId,
		directSpawnerAgentId: null,
		configuration: {
			label: OWNER_LABEL,
			baseline: {
				cwd: session.sessionManager.getCwd(),
				model: { provider: model.provider, modelId: model.id },
				thinking,
				tools: session.getActiveToolNames(),
				skills,
				extensions,
			},
		},
	};
}

function validateOwnerIdentity(
	value: unknown,
	sessionId: string,
	sessionManager: SessionManager,
): OwnerIdentity {
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
		"configuration",
	]);
	if (identity.agentId !== sessionId || identity.workflowId !== sessionId) {
		throw new InvalidOwnerIdentityError("current Pi session is a child Agent");
	}
	if (identity.directSpawnerAgentId !== null) {
		throw new InvalidOwnerIdentityError("Owner directSpawnerAgentId must be null");
	}

	const configuration = requireExactRecord(identity.configuration, ["label", "baseline"]);
	if (configuration.label !== OWNER_LABEL) {
		throw new InvalidOwnerIdentityError('Owner label must be "owner"');
	}
	const baseline = validateBaseline(configuration.baseline);
	if (baseline.cwd !== sessionManager.getCwd()) {
		throw new InvalidOwnerIdentityError("Owner baseline cwd does not match the Pi session cwd");
	}

	return {
		agentId: sessionId,
		workflowId: sessionId,
		directSpawnerAgentId: null,
		configuration: { label: OWNER_LABEL, baseline },
	};
}

function validateBaseline(value: unknown): RuntimeConfigurationBaseline {
	const baseline = requireExactRecord(value, [
		"cwd",
		"model",
		"thinking",
		"tools",
		"skills",
		"extensions",
	]);
	if (typeof baseline.cwd !== "string" || !isAbsolute(baseline.cwd)) {
		throw new InvalidOwnerIdentityError("AgentConfiguration.baseline.cwd is invalid");
	}
	const model = requireExactRecord(baseline.model, ["provider", "modelId"]);
	if (!isNonEmptyIdentifier(model.provider) || !isNonEmptyIdentifier(model.modelId)) {
		throw new InvalidOwnerIdentityError("AgentConfiguration.baseline.model is invalid");
	}
	if (!isRuntimeThinkingLevel(baseline.thinking)) {
		throw new InvalidOwnerIdentityError("AgentConfiguration.baseline.thinking is invalid");
	}
	const tools = validateStringList(baseline.tools, "AgentConfiguration.baseline.tools");
	const skills = validateStringList(baseline.skills, "AgentConfiguration.baseline.skills");
	const extensions = validateStringList(
		baseline.extensions,
		"AgentConfiguration.baseline.extensions",
	);
	return {
		cwd: baseline.cwd,
		model: { provider: model.provider, modelId: model.modelId },
		thinking: baseline.thinking,
		tools,
		skills,
		extensions,
	};
}

function validateCurrentScope(entries: SessionEntry[], identityEntry: SessionEntry): void {
	const cutoff = entries.indexOf(identityEntry);
	for (const entry of entries.slice(cutoff + 1)) {
		if (
			(entry.type === "custom" || entry.type === "custom_message") &&
			entry.customType.startsWith("agent-coordination.")
		) {
			throw new InvalidOwnerIdentityError(
				`unexpected current-scope coordination entry ${entry.customType}`,
			);
		}
	}
}

function validateStringList(value: unknown, name: string): readonly string[] {
	if (!Array.isArray(value) || !value.every(isNonEmptyIdentifier)) {
		throw new InvalidOwnerIdentityError(`${name} is invalid`);
	}
	if (new Set(value).size !== value.length) {
		throw new InvalidOwnerIdentityError(`${name} contains duplicates`);
	}
	return [...value];
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

function isNonEmptyIdentifier(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.includes("\0");
}
