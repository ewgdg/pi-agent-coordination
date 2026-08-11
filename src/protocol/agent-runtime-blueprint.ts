import type {
	SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { isAbsolute } from "node:path";

import type { EffectiveAgentRunConfiguration } from "../templates/agent-configuration.ts";
import { AGENT_RUNTIME_BLUEPRINT_CUSTOM_TYPE } from "./custom-entry-types.ts";
import { ProtocolInvariantError } from "./identities.ts";
import { isRuntimeThinkingLevel } from "./runtime-configuration.ts";

export type AgentRuntimeBlueprint = Readonly<{
	agentId: string;
	role: "ordinary" | "moderator";
	configuration: EffectiveAgentRunConfiguration;
	projectTrusted: boolean;
	skillSources: readonly Readonly<{ name: string; path: string }>[];
	agentsFiles: readonly Readonly<{ path: string; content: string }>[];
}>;

export function commitAgentRuntimeBlueprint(
	sessionManager: SessionManager,
	blueprintValue: AgentRuntimeBlueprint,
): void {
	const blueprint = validateAgentRuntimeBlueprint(blueprintValue);
	if (sessionManager.getSessionId() !== blueprint.agentId) {
		throw new Error("Agent Runtime blueprint does not match its Pi session");
	}
	const entries = sessionManager.getEntries();
	if (entries.length === 0) {
		throw new Error("Agent Runtime blueprint requires committed bootstrap evidence");
	}
	if (entries.some(isRuntimeBlueprintEntry)) {
		throw new Error("Agent Runtime blueprint evidence already exists");
	}
	if (entries.some((entry) => entry.type === "message")) {
		throw new Error("Agent Runtime blueprint must be committed before model work");
	}
	sessionManager.appendCustomEntry(AGENT_RUNTIME_BLUEPRINT_CUSTOM_TYPE, blueprint);
}

export function resolveCommittedAgentRuntimeBlueprint(options: {
	sessionId: string;
	entries: readonly SessionEntry[];
}): AgentRuntimeBlueprint {
	const matching = options.entries.filter(isRuntimeBlueprintEntry);
	if (matching.length !== 1) {
		throw new ProtocolInvariantError(
			`Agent transcript contains ${matching.length} Runtime blueprint entries`,
		);
	}
	const blueprintEntry = matching[0];
	if (!blueprintEntry || blueprintEntry.type !== "custom") {
		throw new Error("Runtime blueprint entry narrowing failed");
	}
	const blueprint = validateAgentRuntimeBlueprint(blueprintEntry.data);
	if (blueprint.agentId !== options.sessionId) {
		throw new ProtocolInvariantError("Agent Runtime blueprint does not match its Pi session");
	}
	return blueprint;
}

function validateAgentRuntimeBlueprint(value: unknown): AgentRuntimeBlueprint {
	const record = requireExactRecord(value, [
		"agentId",
		"role",
		"configuration",
		"projectTrusted",
		"skillSources",
		"agentsFiles",
	], "Agent Runtime blueprint");
	if (!isIdentifier(record.agentId)) {
		throw new ProtocolInvariantError("Agent Runtime blueprint agentId is invalid");
	}
	if (record.role !== "ordinary" && record.role !== "moderator") {
		throw new ProtocolInvariantError("Agent Runtime blueprint role is invalid");
	}
	if (typeof record.projectTrusted !== "boolean") {
		throw new ProtocolInvariantError("Agent Runtime blueprint trust is invalid");
	}
	const configuration = validateEffectiveConfiguration(record.configuration);
	const skillSources = validateSkillSources(record.skillSources);
	if (
		skillSources.length !== configuration.skills.length ||
		skillSources.some((source, index) => source.name !== configuration.skills[index])
	) {
		throw new ProtocolInvariantError(
			"Agent Runtime blueprint skill sources do not match selected skills",
		);
	}
	const agentsFiles = validateAgentsFiles(record.agentsFiles);
	return {
		agentId: record.agentId,
		role: record.role,
		configuration,
		projectTrusted: record.projectTrusted,
		skillSources,
		agentsFiles,
	};
}

function validateEffectiveConfiguration(value: unknown): EffectiveAgentRunConfiguration {
	const input = requireRecord(value, "Agent Runtime configuration");
	const expectedKeys = [
		"cwd",
		"model",
		"thinking",
		"tools",
		"skills",
		"extensions",
		...(input.projectContext === undefined ? [] : ["projectContext"]),
	];
	const configuration = requireExactRecord(
		input,
		expectedKeys,
		"Agent Runtime configuration",
	);
	if (typeof configuration.cwd !== "string" || !isAbsolute(configuration.cwd)) {
		throw new ProtocolInvariantError("Agent Runtime configuration cwd is invalid");
	}
	const model = requireExactRecord(
		configuration.model,
		["provider", "modelId"],
		"Agent Runtime model",
	);
	if (!isIdentifier(model.provider) || !isIdentifier(model.modelId)) {
		throw new ProtocolInvariantError("Agent Runtime configuration model is invalid");
	}
	if (!isRuntimeThinkingLevel(configuration.thinking)) {
		throw new ProtocolInvariantError("Agent Runtime configuration thinking is invalid");
	}
	const tools = validateUniqueStrings(configuration.tools, "tools");
	const skills = validateUniqueStrings(configuration.skills, "skills");
	const extensions = validateUniqueStrings(configuration.extensions, "extensions");
	if (!extensions.every(isAbsolute)) {
		throw new ProtocolInvariantError("Agent Runtime configuration extensions must be absolute");
	}
	let projectContext: EffectiveAgentRunConfiguration["projectContext"];
	if (configuration.projectContext !== undefined) {
		const context = requireExactRecord(
			configuration.projectContext,
			["mode", "body"],
			"Agent Runtime Project Context",
		);
		if (
			(context.mode !== "append" && context.mode !== "replace") ||
			typeof context.body !== "string"
		) {
			throw new ProtocolInvariantError("Agent Runtime Project Context is invalid");
		}
		projectContext = { mode: context.mode, body: context.body };
	}
	return {
		cwd: configuration.cwd,
		model: { provider: model.provider, modelId: model.modelId },
		thinking: configuration.thinking,
		tools,
		skills,
		extensions,
		...(projectContext === undefined ? {} : { projectContext }),
	};
}

function validateSkillSources(value: unknown): readonly Readonly<{ name: string; path: string }>[] {
	if (!Array.isArray(value)) {
		throw new ProtocolInvariantError("Agent Runtime blueprint skillSources is invalid");
	}
	const sources = value.map((candidate) => {
		const source = requireExactRecord(
			candidate,
			["name", "path"],
			"Agent Runtime skill source",
		);
		if (!isIdentifier(source.name) || typeof source.path !== "string" || !isAbsolute(source.path)) {
			throw new ProtocolInvariantError("Agent Runtime skill source is invalid");
		}
		return { name: source.name, path: source.path };
	});
	if (new Set(sources.map(({ name }) => name)).size !== sources.length) {
		throw new ProtocolInvariantError("Agent Runtime blueprint skill sources contain duplicates");
	}
	return sources;
}

function validateAgentsFiles(value: unknown): readonly Readonly<{ path: string; content: string }>[] {
	if (!Array.isArray(value)) {
		throw new ProtocolInvariantError("Agent Runtime blueprint agentsFiles is invalid");
	}
	const files = value.map((candidate) => {
		const file = requireExactRecord(
			candidate,
			["path", "content"],
			"Agent Runtime context file",
		);
		if (!isIdentifier(file.path) || typeof file.content !== "string") {
			throw new ProtocolInvariantError("Agent Runtime context file is invalid");
		}
		return { path: file.path, content: file.content };
	});
	if (new Set(files.map(({ path }) => path)).size !== files.length) {
		throw new ProtocolInvariantError("Agent Runtime context files contain duplicate paths");
	}
	return files;
}

function validateUniqueStrings(value: unknown, field: string): readonly string[] {
	if (!Array.isArray(value) || !value.every(isIdentifier)) {
		throw new ProtocolInvariantError(`Agent Runtime configuration ${field} is invalid`);
	}
	if (new Set(value).size !== value.length) {
		throw new ProtocolInvariantError(`Agent Runtime configuration ${field} contains duplicates`);
	}
	return [...value];
}

function isRuntimeBlueprintEntry(
	entry: SessionEntry,
): entry is Extract<SessionEntry, { type: "custom" }> {
	return entry.type === "custom" && entry.customType === AGENT_RUNTIME_BLUEPRINT_CUSTOM_TYPE;
}

function requireExactRecord(
	value: unknown,
	expectedKeys: readonly string[],
	name: string,
): Record<string, unknown> {
	const record = requireRecord(value, name);
	const actual = Object.keys(record).sort();
	const expected = [...expectedKeys].sort();
	if (
		actual.length !== expected.length ||
		actual.some((key, index) => key !== expected[index])
	) {
		throw new ProtocolInvariantError(`${name} has an invalid shape`);
	}
	return record;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new ProtocolInvariantError(`${name} must be an object`);
	}
	return value as Record<string, unknown>;
}

function isIdentifier(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.includes("\0");
}
