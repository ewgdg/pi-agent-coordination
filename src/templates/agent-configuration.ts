import { resolve } from "node:path";

import type {
	InheritableRuntimeConfiguration,
	ModelReference,
	RuntimeThinkingLevel,
} from "../protocol/runtime-configuration.ts";
import type {
	AgentTemplate,
	SystemPromptMode,
} from "./agent-templates.ts";

export type AgentSpawnConfigurationInput = Readonly<{
	model?: Readonly<{
		id: string | "inherit";
		thinking: RuntimeThinkingLevel | "inherit";
	}>;
	cwd?: string;
	allowedTools?: readonly string[];
	skills?: readonly string[];
	extensions?: "inherit" | "none";
	systemPrompt?: string;
	systemPromptMode?: SystemPromptMode;
	loadContextFiles?: boolean;
}>;

export type EffectiveAgentRunConfiguration = Readonly<{
	cwd: string;
	model: ModelReference;
	thinking: RuntimeThinkingLevel;
	allowedTools: readonly string[];
	skills: readonly string[];
	extensions: readonly string[];
	systemPrompt?: Readonly<{
		mode: SystemPromptMode;
		body: string;
	}>;
	loadContextFiles: boolean;
}>;

/** Launch input may delegate thinking selection to Pi while all other values stay explicit. */
export type AgentRunLaunchConfiguration = Readonly<
	Omit<EffectiveAgentRunConfiguration, "thinking"> & {
		thinking?: RuntimeThinkingLevel;
	}
>;

export function resolveAgentRunConfiguration(options: {
	inherited: InheritableRuntimeConfiguration;
	template?: AgentTemplate;
	overrides?: AgentSpawnConfigurationInput;
	fixedAllowedTools: readonly string[];
	isModelAvailable(model: ModelReference): boolean;
}): EffectiveAgentRunConfiguration {
	const { inherited, template, overrides } = options;
	const configuredAllowedTools = overrides?.allowedTools
		?? template?.allowedTools
		?? inherited.allowedTools;
	const configuredSkills = overrides?.skills ?? template?.skills ?? inherited.skills;
	const templateExtensions = resolveExtensions(template?.extensions, inherited.extensions);
	const configuredExtensions = resolveExtensions(
		overrides?.extensions,
		templateExtensions,
		inherited.extensions,
	);
	const systemPrompt = resolveSystemPrompt(template, overrides);
	const loadContextFiles = overrides?.loadContextFiles
		?? template?.loadContextFiles
		?? true;
	const explicitlySelectedModel = overrides?.model && overrides.model.id !== "inherit"
		? parseModelId(overrides.model.id)
		: undefined;
	if (explicitlySelectedModel && !options.isModelAvailable(explicitlySelectedModel)) {
		throw new Error(
			`Configured Agent model is unavailable: ${explicitlySelectedModel.provider}/${explicitlySelectedModel.modelId}`,
		);
	}
	const modelConfiguration = overrides?.model
		? {
			model: explicitlySelectedModel ?? inherited.model,
			thinking: overrides.model.thinking === "inherit"
				? inherited.thinking
				: overrides.model.thinking,
		}
		: resolveTemplateModelConfiguration(
			inherited,
			template?.models,
			options.isModelAvailable,
		);

	return {
		cwd: resolve(inherited.cwd, overrides?.cwd ?? inherited.cwd),
		model: { ...modelConfiguration.model },
		thinking: modelConfiguration.thinking,
		allowedTools: unique([...configuredAllowedTools, ...options.fixedAllowedTools]),
		skills: [...configuredSkills],
		extensions: [...configuredExtensions],
		...(systemPrompt === undefined ? {} : { systemPrompt }),
		loadContextFiles,
	};
}

function parseModelId(id: string): ModelReference {
	const separator = id.indexOf("/");
	return { provider: id.slice(0, separator), modelId: id.slice(separator + 1) };
}

function resolveTemplateModelConfiguration(
	inherited: Readonly<{ model: ModelReference; thinking: RuntimeThinkingLevel }>,
	templateModels: AgentTemplate["models"],
	isModelAvailable: (model: ModelReference) => boolean,
): Readonly<{ model: ModelReference; thinking: RuntimeThinkingLevel }> {
	if (!templateModels) return { model: inherited.model, thinking: inherited.thinking };
	const selected = templateModels.find(({ model }) => isModelAvailable(model));
	if (selected) return selected;
	throw new Error(
		`No configured Agent Template model is available: ${templateModels.map(({ model }) => `${model.provider}/${model.modelId}`).join(", ")}`,
	);
}

function resolveExtensions(
	selection: "inherit" | "none" | undefined,
	inherited: readonly string[],
	parentExtensions: readonly string[] = inherited,
): readonly string[] {
	if (selection === undefined) return inherited;
	if (selection === "inherit") return parentExtensions;
	return [];
}

function resolveSystemPrompt(
	template: AgentTemplate | undefined,
	overrides: AgentSpawnConfigurationInput | undefined,
): EffectiveAgentRunConfiguration["systemPrompt"] {
	const templatePrompt = template
		? { mode: template.systemPromptMode, body: template.systemPrompt }
		: undefined;
	if (overrides?.systemPrompt === undefined) {
		if (templatePrompt === undefined || overrides?.systemPromptMode === undefined) {
			return templatePrompt;
		}
		return { ...templatePrompt, mode: overrides.systemPromptMode };
	}
	const next = {
		mode: overrides.systemPromptMode ?? "append",
		body: overrides.systemPrompt,
	} as const;
	if (next.mode === "replace" || templatePrompt === undefined) return next;
	return {
		mode: templatePrompt.mode,
		body: joinContext(templatePrompt.body, next.body),
	};
}

function joinContext(left: string, right: string): string {
	if (left.length === 0) return right;
	if (right.length === 0) return left;
	return `${left}\n\n${right}`;
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}
