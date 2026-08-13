import {
	DefaultResourceLoader,
	ProjectTrustStore,
	SettingsManager,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import type {
	InheritableRuntimeConfiguration,
} from "../protocol/runtime-configuration.ts";
import {
	resolveAgentRunConfiguration,
	type AgentSpawnConfigurationInput,
	type EffectiveAgentRunConfiguration,
} from "../templates/agent-configuration.ts";
import type { AgentTemplate } from "../templates/agent-templates.ts";

const COORDINATION_TOOLS_BY_ROLE = {
	ordinary: [
		"agent_message",
		"agent_control",
		"agent_observe",
		"agent_spawn",
		"ask_user_question",
	],
	moderator: [
		"agent_message",
		"agent_control",
		"agent_observe",
		"ask_user_question",
		"moderator_control",
	],
} as const;
const COORDINATION_TOOL_NAMES = new Set<string>(
	Object.values(COORDINATION_TOOLS_BY_ROLE).flat(),
);

export type AgentRuntimeRole = "ordinary" | "moderator";

export type ResolvedParentRuntime = Readonly<{
	configuration: InheritableRuntimeConfiguration;
	projectTrusted: boolean;
	skillSources: readonly Readonly<Pick<Skill, "name" | "filePath">>[];
}>;

export type PreparedChildRuntime = Readonly<{
	agentId: string;
	role: AgentRuntimeRole;
	configuration: EffectiveAgentRunConfiguration;
	projectTrusted: boolean;
	skillSources: readonly Readonly<{ name: string; path: string }>[];
	agentsFiles: readonly Readonly<{ path: string; content: string }>[];
}>;

export async function prepareChildRuntime(options: {
	agentId: string;
	role: AgentRuntimeRole;
	agentDir: string;
	parentRuntime: ResolvedParentRuntime;
	template?: AgentTemplate;
	overrides?: AgentSpawnConfigurationInput;
}): Promise<PreparedChildRuntime> {
	validateParentSkillSources(options.parentRuntime);
	const inheritedExtensions = inheritsParentExtensions(
		options.template?.extensions,
		options.overrides?.extensions,
	)
		? await canonicalFileExtensions(options.parentRuntime.configuration.extensions)
		: [];
	const resolvedConfiguration = resolveAgentRunConfiguration({
		inherited: {
			...options.parentRuntime.configuration,
			extensions: inheritedExtensions,
		},
		template: options.template,
		overrides: options.overrides,
		fixedTools: [],
	});
	const configuration = {
		...resolvedConfiguration,
		tools: [
			...resolvedConfiguration.tools.filter(
				(name) => !COORDINATION_TOOL_NAMES.has(name),
			),
			...COORDINATION_TOOLS_BY_ROLE[options.role],
		],
	};
	await requireDirectory(configuration.cwd);

	const projectTrusted = await resolveProjectTrust({
		parentCwd: options.parentRuntime.configuration.cwd,
		effectiveCwd: configuration.cwd,
		parentProjectTrusted: options.parentRuntime.projectTrusted,
		agentDir: options.agentDir,
	});
	const settingsManager = SettingsManager.create(
		configuration.cwd,
		options.agentDir,
		{ projectTrusted },
	);
	const resourceLoader = new DefaultResourceLoader({
		cwd: configuration.cwd,
		agentDir: options.agentDir,
		settingsManager,
		additionalSkillPaths: options.parentRuntime.skillSources.map(
			({ filePath }) => filePath,
		),
		// Extension modules belong to the fresh child process. Runtime preparation
		// resolves paths but never imports or invokes child extension factories.
		noExtensions: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	await resourceLoader.reload();

	const selectedSkills = resolveSelectedSkills(
		configuration.skills,
		resourceLoader.getSkills(),
	);
	const configuredContext = configuration.projectContext;
	const ordinaryContext = resourceLoader.getAgentsFiles().agentsFiles.map(
		({ path, content }) => ({ path, content }),
	);
	let agentsFiles = ordinaryContext;
	if (configuredContext !== undefined) {
		const contextFile = {
			path: `<agent-configuration:${options.agentId}>`,
			content: configuredContext.body,
		};
		agentsFiles = configuredContext.mode === "replace"
			? [contextFile]
			: [...ordinaryContext, contextFile];
	}

	return {
		agentId: options.agentId,
		role: options.role,
		configuration,
		projectTrusted,
		skillSources: selectedSkills.map(({ name, filePath }) => ({
			name,
			path: filePath,
		})),
		agentsFiles,
	};
}

function inheritsParentExtensions(
	template: AgentTemplate["extensions"],
	overrides: AgentSpawnConfigurationInput["extensions"],
): boolean {
	if (overrides !== undefined) return overrides === "inherit";
	return template !== "none";
}

function validateParentSkillSources(parentRuntime: ResolvedParentRuntime): void {
	if (
		parentRuntime.skillSources.length !== parentRuntime.configuration.skills.length ||
		parentRuntime.skillSources.some(
			(source, index) => source.name !== parentRuntime.configuration.skills[index],
		)
	) {
		throw new Error("Parent Runtime skill sources do not match its selected skills");
	}
	for (const source of parentRuntime.skillSources) {
		if (!isAbsolute(source.filePath)) {
			throw new Error(`Parent Runtime skill source is not absolute: ${source.name}`);
		}
	}
}

async function canonicalFileExtensions(paths: readonly string[]): Promise<string[]> {
	const canonical: string[] = [];
	const seen = new Set<string>();
	for (const path of paths) {
		if (!isAbsolute(path)) continue;
		const resolvedPath = await realpath(path);
		if (!(await stat(resolvedPath)).isFile()) {
			throw new Error(`Inherited extension is not file-backed: ${path}`);
		}
		if (seen.has(resolvedPath)) continue;
		seen.add(resolvedPath);
		canonical.push(resolvedPath);
	}
	return canonical;
}

async function requireDirectory(path: string): Promise<void> {
	if (!(await stat(path)).isDirectory()) {
		throw new Error("Configured working directory is not a directory");
	}
}

async function resolveProjectTrust(options: {
	parentCwd: string;
	effectiveCwd: string;
	parentProjectTrusted: boolean;
	agentDir: string;
}): Promise<boolean> {
	const [effectiveCwd, parentCwd] = await Promise.all([
		realpath(options.effectiveCwd),
		realpath(options.parentCwd),
	]);
	if (effectiveCwd === parentCwd) return options.parentProjectTrusted;
	const saved = new ProjectTrustStore(options.agentDir).get(options.effectiveCwd);
	if (saved !== null) return saved;
	const globalSettings = SettingsManager.create(
		options.effectiveCwd,
		options.agentDir,
		{ projectTrusted: false },
	);
	return globalSettings.getDefaultProjectTrust() === "always";
}

function resolveSelectedSkills(
	selectedNames: readonly string[],
	loaded: ReturnType<DefaultResourceLoader["getSkills"]>,
): Skill[] {
	for (const diagnostic of loaded.diagnostics) {
		if (
			diagnostic.type === "collision" &&
			diagnostic.collision?.resourceType === "skill" &&
			selectedNames.includes(diagnostic.collision.name)
		) {
			throw new Error(`Agent skill resource is ambiguous: ${diagnostic.collision.name}`);
		}
	}
	return selectedNames.map((name) => {
		const matching = loaded.skills.filter((skill) => skill.name === name);
		if (matching.length !== 1) {
			throw new Error(`Agent skill resource is unavailable: ${name}`);
		}
		const skill = matching[0]!;
		if (!isAbsolute(skill.filePath)) {
			throw new Error(`Agent skill source is not absolute: ${name}`);
		}
		return skill;
	});
}
