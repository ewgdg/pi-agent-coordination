import { resolve } from "node:path";

import type {
	ModelReference,
	RuntimeConfigurationBaseline,
} from "../protocol/owner-identity.ts";
import type {
	AgentTemplate,
	ProjectContextMode,
} from "./agent-templates.ts";

export type AgentSpawnConfigurationInput = Readonly<{
	model?: ModelReference;
	thinking?: RuntimeConfigurationBaseline["thinking"];
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
	thinking: RuntimeConfigurationBaseline["thinking"];
	tools: readonly string[];
	skills: readonly string[];
	extensions: readonly string[];
	projectContext?: Readonly<{
		mode: ProjectContextMode;
		body: string;
	}>;
}>;

export function resolveAgentRunConfiguration(options: {
	baseline: RuntimeConfigurationBaseline;
	template?: AgentTemplate;
	overrides?: AgentSpawnConfigurationInput;
	fixedTools: readonly string[];
}): EffectiveAgentRunConfiguration {
	const { baseline, template, overrides } = options;
	const configuredTools = overrides?.tools ?? template?.tools ?? baseline.tools;
	const configuredSkills = overrides?.skills ?? template?.skills ?? baseline.skills;
	const templateExtensions = resolveExtensions(template?.extensions, baseline.extensions);
	const configuredExtensions = resolveExtensions(overrides?.extensions, templateExtensions, baseline.extensions);
	const projectContext = resolveProjectContext(template, overrides);

	return {
		cwd: resolve(baseline.cwd, overrides?.cwd ?? baseline.cwd),
		model: {
			...(overrides?.model ?? template?.model ?? baseline.model),
		},
		thinking: overrides?.thinking ?? template?.thinking ?? baseline.thinking,
		tools: unique([...configuredTools, ...options.fixedTools]),
		skills: [...configuredSkills],
		extensions: [...configuredExtensions],
		...(projectContext === undefined ? {} : { projectContext }),
	};
}

function resolveExtensions(
	selection: "inherit" | "none" | readonly string[] | undefined,
	inherited: readonly string[],
	baseline: readonly string[] = inherited,
): readonly string[] {
	if (selection === undefined) return inherited;
	if (selection === "inherit") return baseline;
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
