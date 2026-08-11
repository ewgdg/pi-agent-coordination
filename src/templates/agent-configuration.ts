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
	model?: ModelReference;
	thinking?: RuntimeThinkingLevel;
	cwd?: string;
	tools?: readonly string[];
	skills?: readonly string[];
	extensions?: "inherit" | "none" | readonly string[];
	projectContext?: string;
	projectContextMode?: ProjectContextMode;
}>;

export type EffectiveAgentRunConfiguration = Readonly<{
	cwd: string;
	model: ModelReference;
	thinking: RuntimeThinkingLevel;
	tools: readonly string[];
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
	fixedTools: readonly string[];
}): EffectiveAgentRunConfiguration {
	const { inherited, template, overrides } = options;
	const configuredTools = overrides?.tools ?? template?.tools ?? inherited.tools;
	const configuredSkills = overrides?.skills ?? template?.skills ?? inherited.skills;
	const templateExtensions = resolveExtensions(template?.extensions, inherited.extensions);
	const configuredExtensions = resolveExtensions(
		overrides?.extensions,
		templateExtensions,
		inherited.extensions,
	);
	const projectContext = resolveProjectContext(template, overrides);

	return {
		cwd: resolve(inherited.cwd, overrides?.cwd ?? inherited.cwd),
		model: {
			...(overrides?.model ?? template?.model ?? inherited.model),
		},
		thinking: overrides?.thinking ?? template?.thinking ?? inherited.thinking,
		tools: unique([...configuredTools, ...options.fixedTools]),
		skills: [...configuredSkills],
		extensions: [...configuredExtensions],
		...(projectContext === undefined ? {} : { projectContext }),
	};
}

function resolveExtensions(
	selection: "inherit" | "none" | readonly string[] | undefined,
	inherited: readonly string[],
	parentExtensions: readonly string[] = inherited,
): readonly string[] {
	if (selection === undefined) return inherited;
	if (selection === "inherit") return parentExtensions;
	if (selection === "none") return [];
	return selection;
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
