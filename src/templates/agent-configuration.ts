import { resolve } from "node:path";

import type {
	InheritableRuntimeConfiguration,
	ModelReference,
	RuntimeThinkingLevel,
} from "../protocol/runtime-configuration.ts";
import type {
	AgentTemplate,
	ProjectContextMode,
} from "./agent-templates.ts";

export type AgentSpawnConfigurationInput = Readonly<{
	model?: Readonly<{
		id: string | "inherit";
		thinking: RuntimeThinkingLevel | "inherit";
	}>;
	cwd?: string;
	allowed_tools?: readonly string[];
	skills?: readonly string[];
	extensions?: "inherit" | "none";
	projectContext?: string;
	projectContextMode?: ProjectContextMode;
}>;

export type EffectiveAgentRunConfiguration = Readonly<{
	cwd: string;
	model: ModelReference;
	thinking: RuntimeThinkingLevel;
	allowedTools: readonly string[];
	skills: readonly string[];
	extensions: readonly string[];
	projectContext?: Readonly<{
		mode: ProjectContextMode;
		body: string;
	}>;
}>;

export function resolveAgentRunConfiguration(options: {
	inherited: InheritableRuntimeConfiguration;
	template?: AgentTemplate;
	overrides?: AgentSpawnConfigurationInput;
	fixedAllowedTools: readonly string[];
	isModelAvailable(model: ModelReference): boolean;
}): EffectiveAgentRunConfiguration {
	const { inherited, template, overrides } = options;
	const configuredAllowedTools = overrides?.allowed_tools
		?? template?.allowedTools
		?? inherited.allowedTools;
	const configuredSkills = overrides?.skills ?? template?.skills ?? inherited.skills;
	const templateExtensions = resolveExtensions(template?.extensions, inherited.extensions);
	const configuredExtensions = resolveExtensions(
		overrides?.extensions,
		templateExtensions,
		inherited.extensions,
	);
	const projectContext = resolveProjectContext(template, overrides);
	const modelConfiguration = overrides?.model
		? {
			model: overrides.model.id === "inherit"
				? inherited.model
				: parseModelId(overrides.model.id),
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
		...(projectContext === undefined ? {} : { projectContext }),
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

function resolveProjectContext(
	template: AgentTemplate | undefined,
	overrides: AgentSpawnConfigurationInput | undefined,
): EffectiveAgentRunConfiguration["projectContext"] {
	let context = template
		? { mode: template.projectContextMode, body: template.projectContext }
		: undefined;
	if (overrides?.projectContext === undefined) return context;
	const next = {
		mode: overrides.projectContextMode ?? "append",
		body: overrides.projectContext,
	} as const;
	if (next.mode === "replace" || context === undefined) return next;
	return {
		mode: context.mode,
		body: joinContext(context.body, next.body),
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
