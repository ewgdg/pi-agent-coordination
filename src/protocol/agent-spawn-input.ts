import type { AgentSpawnConfigurationInput } from "../templates/agent-configuration.ts";
import { isAgentTemplateName } from "../templates/agent-template-name.ts";
import {
	isRuntimeThinkingLevel,
	type RuntimeThinkingLevel,
} from "./runtime-configuration.ts";


export type AgentSpawnInput = Readonly<{
	request: string;
	template?: string;
	label?: string;
	description?: string;
	config?: AgentSpawnConfigurationInput;
}>;

export function validateAgentSpawnInput(value: Record<string, unknown>): AgentSpawnInput {
	requireExactKeys(value, [
		"request",
		...(value.template === undefined ? [] : ["template"]),
		...(value.label === undefined ? [] : ["label"]),
		...(value.description === undefined ? [] : ["description"]),
		...(value.config === undefined ? [] : ["config"]),
	]);
	if (typeof value.request !== "string" || value.request.length === 0) {
		throw new Error("invalid_input: Agent Spawn request must not be empty");
	}
	const template = optionalString(value.template, "template");
	if (template !== undefined) {
		if (!isAgentTemplateName(template)) {
			throw new Error("invalid_input: Agent Spawn template must be lowercase kebab-case");
		}
		if (template === "moderator") {
			throw new Error("invalid_input: Agent Spawn template moderator is reserved");
		}
	}
	const label = optionalString(value.label, "label");
	const description = optionalString(value.description, "description");
	const config = value.config === undefined ? undefined : validateConfiguration(value.config);
	return {
		request: value.request,
		...(template === undefined ? {} : { template }),
		...(label === undefined ? {} : { label }),
		...(description === undefined ? {} : { description }),
		...(config === undefined ? {} : { config }),
	};
}

function validateConfiguration(value: unknown): AgentSpawnConfigurationInput {
	if (!isRecord(value)) {
		throw new Error("invalid_input: Agent Spawn config must be an object");
	}
	requireExactKeys(value, [
		...(value.model === undefined ? [] : ["model"]),
		...(value.cwd === undefined ? [] : ["cwd"]),
		...(value.tools === undefined ? [] : ["tools"]),
		...(value.skills === undefined ? [] : ["skills"]),
		...(value.extensions === undefined ? [] : ["extensions"]),
		...(value.projectContext === undefined ? [] : ["projectContext"]),
		...(value.projectContextMode === undefined ? [] : ["projectContextMode"]),
	]);
	const model = value.model === undefined ? undefined : validateModel(value.model);
	const cwd = value.cwd === undefined ? undefined : requireNonEmptyString(value.cwd, "cwd");
	const tools = value.tools === undefined ? undefined : validateStringList(value.tools, "tools");
	const skills = value.skills === undefined ? undefined : validateStringList(value.skills, "skills");
	const extensions = value.extensions === undefined
		? undefined
		: validateExtensions(value.extensions);
	const projectContext = value.projectContext;
	if (projectContext !== undefined && typeof projectContext !== "string") {
		throw new Error("invalid_input: Agent Spawn config.projectContext must be a string");
	}
	const projectContextMode = value.projectContextMode;
	if (
		projectContextMode !== undefined &&
		projectContextMode !== "append" &&
		projectContextMode !== "replace"
	) {
		throw new Error(
			'invalid_input: Agent Spawn config.projectContextMode must be "append" or "replace"',
		);
	}
	if (projectContextMode !== undefined && projectContext === undefined) {
		throw new Error(
			"invalid_input: Agent Spawn config.projectContextMode requires projectContext",
		);
	}
	return {
		...(model === undefined ? {} : { model }),
		...(cwd === undefined ? {} : { cwd }),
		...(tools === undefined ? {} : { tools }),
		...(skills === undefined ? {} : { skills }),
		...(extensions === undefined ? {} : { extensions }),
		...(projectContext === undefined ? {} : { projectContext }),
		...(projectContextMode === undefined ? {} : { projectContextMode }),
	};
}

function validateModel(value: unknown): NonNullable<AgentSpawnConfigurationInput["model"]> {
	if (!isRecord(value)) {
		throw new Error("invalid_input: Agent Spawn config.model must be an object");
	}
	requireExactKeys(value, ["id", "thinking"]);
	const id = value.id === "inherit"
		? "inherit"
		: validateModelId(value.id);
	const thinking = value.thinking === "inherit"
		? "inherit"
		: validateThinking(value.thinking);
	return {
		id,
		thinking,
	};
}

function validateModelId(value: unknown): string {
	const id = requireNonEmptyString(value, "model.id");
	const separator = id.indexOf("/");
	if (separator <= 0 || separator === id.length - 1) {
		throw new Error('invalid_input: Agent Spawn config.model.id must be provider/model or "inherit"');
	}
	return id;
}

function validateThinking(value: unknown): RuntimeThinkingLevel {
	if (!isRuntimeThinkingLevel(value)) {
		throw new Error("invalid_input: Agent Spawn config.thinking is invalid");
	}
	return value;
}

function validateExtensions(value: unknown): "inherit" | "none" {
	if (value === "inherit" || value === "none") return value;
	throw new Error(
		'invalid_input: Agent Spawn config.extensions must be "inherit" or "none"',
	);
}

function validateStringList(value: unknown, field: string): readonly string[] {
	if (!Array.isArray(value)) {
		throw new Error(`invalid_input: Agent Spawn config.${field} must be a string array`);
	}
	const values = value.map((item) => requireNonEmptyString(item, field));
	if (new Set(values).size !== values.length) {
		throw new Error(`invalid_input: Agent Spawn config.${field} contains duplicates`);
	}
	return values;
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		throw new Error(`invalid_input: Agent Spawn ${field} must be a string`);
	}
	return value;
}

function requireNonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
		throw new Error(`invalid_input: Agent Spawn config.${field} is invalid`);
	}
	return value;
}

function requireExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): void {
	const actual = Object.keys(value).sort();
	const expected = [...expectedKeys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		throw new Error("invalid_input: Agent Spawn input has an invalid shape");
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
