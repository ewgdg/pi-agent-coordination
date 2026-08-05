import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	hasTrustRequiringProjectResources,
	SettingsManager,
	type AgentSession,
	type AgentSessionRuntime,
	type AgentSessionServices,
	type ExtensionFactory,
	type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
	requireLiveSession,
	type AgentRecord,
} from "../coordination/agent-record.ts";
import { copyExtensionBindings } from "../pi-integration/extension-bindings.ts";
import { resolveAgentRunProjectTrust } from "../pi-integration/project-trust.ts";
import type { AgentSpawnInput } from "../protocol/agent-spawn-input.ts";
import { ProtocolInvariantError } from "../protocol/identities.ts";
import type {
	OwnerIdentity,
	RuntimeConfigurationBaseline,
} from "../protocol/owner-identity.ts";
import {
	resolveAgentRunConfiguration,
	type EffectiveAgentRunConfiguration,
} from "../templates/agent-configuration.ts";
import { discoverAgentTemplates } from "../templates/agent-template-discovery.ts";
import {
	selectAgentTemplateForRun,
	type AgentTemplate,
	type AgentTemplateRoot,
} from "../templates/agent-templates.ts";

export const ORDINARY_COORDINATION_TOOLS = [
	"agent_message",
	"agent_control",
	"agent_observe",
	"agent_spawn",
	"ask_user_question",
] as const;

const BUILT_IN_TOOL_NAMES = new Set(["bash", "edit", "find", "grep", "ls", "read", "write"]);
const CHILD_EXTENSION_PREFIX = "<inline:pi-agent-coordination-agent:";
const INLINE_PUBLIC_EXTENSION_PATH = "<inline:pi-agent-coordination>";
const WORKFLOW_SESSION_DIRECTORY = "pi-agent-coordination";

export type ChildRunBlueprint = Readonly<{
	baseline: RuntimeConfigurationBaseline;
	spawnInput: AgentSpawnInput;
}>;

export type PreparedAgentRun = Readonly<{
	services: AgentSessionServices;
	configuration: EffectiveAgentRunConfiguration;
}>;

export class DefaultChildSessionFactory {
	readonly #ownerRuntime: AgentSessionRuntime;
	readonly #ownerIdentity: OwnerIdentity;
	readonly #entryModulePath: string;
	readonly #packageRoot: string;
	readonly #childExtensionFactory: (agentId: string) => ExtensionFactory;
	readonly #templateRoots: ((baselineCwd: string, projectTrusted: boolean) => readonly AgentTemplateRoot[]) | undefined;
	readonly #projectTrustByCwd = new Map<string, boolean>();

	constructor(options: {
		ownerRuntime: AgentSessionRuntime;
		ownerIdentity: OwnerIdentity;
		entryModulePath: string;
		packageRoot: string;
		childExtensionFactory(agentId: string): ExtensionFactory;
		templateRoots?(baselineCwd: string, projectTrusted: boolean): readonly AgentTemplateRoot[];
	}) {
		this.#ownerRuntime = options.ownerRuntime;
		this.#ownerIdentity = options.ownerIdentity;
		this.#entryModulePath = options.entryModulePath;
		this.#packageRoot = options.packageRoot;
		this.#childExtensionFactory = options.childExtensionFactory;
		this.#templateRoots = options.templateRoots;
	}

	snapshotRuntimeBaseline(parent: AgentRecord): RuntimeConfigurationBaseline {
		const parentSession = requireLiveSession(parent);
		const model = parentSession.model;
		if (!model) throw new Error("Parent model is unavailable");
		if (!parent.services.modelRuntime.getModel(model.provider, model.id)) {
			throw new Error("Inherited model is unavailable");
		}
		const skills = parent.services.resourceLoader.getSkills().skills;
		const extensions = parent.services.resourceLoader
			.getExtensions()
			.extensions.filter((extension) => !this.#isCoordinationExtension(extension.path, extension.resolvedPath));
		const baseline = {
			// SessionManager cwd is the durable transcript header cwd. Services cwd is
			// the current Run's effective cwd and is what descendants must inherit.
			cwd: parent.services.cwd,
			model: { provider: model.provider, modelId: model.id },
			thinking: parentSession.thinkingLevel,
			tools: parentSession
				.getActiveToolNames()
				.filter(
					(name) =>
						!ORDINARY_COORDINATION_TOOLS.includes(
							name as (typeof ORDINARY_COORDINATION_TOOLS)[number],
						),
				),
			skills: skills.map(({ name }) => name),
			extensions: extensions.map(({ resolvedPath }) => resolvedPath),
		} satisfies RuntimeConfigurationBaseline;
		this.#projectTrustByCwd.set(
			baseline.cwd,
			parent.services.settingsManager.isProjectTrusted(),
		);
		return baseline;
	}

	async prepareRun(agentId: string, blueprint: ChildRunBlueprint): Promise<PreparedAgentRun> {
		const template = await this.#resolveSelectedTemplate(blueprint);
		const configuration = resolveAgentRunConfiguration({
			baseline: blueprint.baseline,
			template,
			overrides: blueprint.spawnInput.config,
			fixedTools: ORDINARY_COORDINATION_TOOLS,
		});
		await this.#validateWorkingDirectory(configuration.cwd);
		const cachedProjectTrust = this.#projectTrustByCwd.get(configuration.cwd);
		const trustResolutionRequired =
			cachedProjectTrust === undefined &&
			hasTrustRequiringProjectResources(configuration.cwd);
		const projectTrusted = cachedProjectTrust ?? !trustResolutionRequired;
		const projectTrustDiagnostics: string[] = [];
		const services = await createAgentSessionServices({
			cwd: configuration.cwd,
			agentDir: this.#ownerRuntime.services.agentDir,
			modelRuntime: this.#ownerRuntime.services.modelRuntime,
			settingsManager: SettingsManager.create(
				configuration.cwd,
				this.#ownerRuntime.services.agentDir,
				{ projectTrusted },
			),
			...(trustResolutionRequired
				? {
					resourceLoaderReloadOptions: {
						resolveProjectTrust: async ({ extensionsResult }) => {
							const resolution = await resolveAgentRunProjectTrust({
								cwd: configuration.cwd,
								agentDir: this.#ownerRuntime.services.agentDir,
								defaultProjectTrust: this.#ownerRuntime.services.settingsManager
									.getDefaultProjectTrust(),
								extensionsResult,
							});
							this.#projectTrustByCwd.set(configuration.cwd, resolution.trusted);
							projectTrustDiagnostics.push(...resolution.diagnostics);
							return resolution.trusted;
						},
					},
				}
				: {}),
			resourceLoaderOptions: {
				noExtensions: true,
				additionalExtensionPaths: [...configuration.extensions],
				extensionFactories: [
					{
						name: `pi-agent-coordination-agent:${agentId}`,
						hidden: true,
						factory: this.#childExtensionFactory(agentId),
					},
				],
				skillsOverride: (loaded) => ({
					skills: configuration.skills.flatMap((name) => {
						const skill = loaded.skills.find((candidate) => candidate.name === name);
						return skill ? [skill] : [];
					}),
					diagnostics: loaded.diagnostics,
				}),
				agentsFilesOverride: (loaded) => ({
					agentsFiles: this.#applyProjectContext(
						loaded.agentsFiles,
						configuration,
						agentId,
					),
				}),
			},
		});
		services.diagnostics.push(
			...projectTrustDiagnostics.map((message) => ({ type: "warning" as const, message })),
		);
		const extensions = services.resourceLoader.getExtensions();
		const skills = services.resourceLoader.getSkills();
		if (
			!services.modelRuntime.getModel(
				configuration.model.provider,
				configuration.model.modelId,
			)
		) {
			throw new Error("Configured model is unavailable");
		}
		if (
			services.diagnostics.some(({ type }) => type === "error") ||
			extensions.errors.length > 0 ||
			this.#hasInvalidSelectedSkill(skills.diagnostics, configuration.skills)
		) {
			throw new Error("Child resource validation failed");
		}
		const loadedSkillNames = new Set(skills.skills.map(({ name }) => name));
		for (const skillName of configuration.skills) {
			if (!loadedSkillNames.has(skillName)) {
				throw new Error(`Child skill resource is unavailable: ${skillName}`);
			}
		}
		const extensionTools = new Set(
			extensions.extensions.flatMap((extension) => [...extension.tools.keys()]),
		);
		for (const toolName of configuration.tools) {
			if (!BUILT_IN_TOOL_NAMES.has(toolName) && !extensionTools.has(toolName)) {
				throw new Error(`Child tool resource is unavailable: ${toolName}`);
			}
		}
		const verifiedExtensions = extensions.extensions
			.filter((extension) => !this.#isCoordinationExtension(extension.path, extension.resolvedPath))
			.map(({ resolvedPath }) => resolvedPath);
		return {
			services,
			configuration: {
				...configuration,
				extensions: verifiedExtensions,
			},
		};
	}

	async startSession(options: {
		sessionManager: SessionManager;
		prepared: PreparedAgentRun;
	}): Promise<AgentSession> {
		const { sessionManager, prepared } = options;
		const model = prepared.services.modelRuntime.getModel(
			prepared.configuration.model.provider,
			prepared.configuration.model.modelId,
		);
		if (!model) throw new Error("Configured model is unavailable");
		const created = await createAgentSessionFromServices({
			services: prepared.services,
			sessionManager,
			sessionStartEvent: { type: "session_start", reason: "startup" },
			model,
			thinkingLevel: prepared.configuration.thinking,
			tools: [...prepared.configuration.tools],
		});
		const session = created.session;
		try {
			this.#validateStartedSession(session, prepared.configuration);
			const bindings = copyExtensionBindings(this.#ownerRuntime.session, session);
			const ownerErrorListener = bindings.onError;
			const startupErrors: string[] = [];
			bindings.onError = (error) => {
				startupErrors.push(error.error);
				ownerErrorListener?.(error);
			};
			await session.bindExtensions(bindings);
			if (startupErrors.length > 0) {
				throw new Error(`Child extension startup failed: ${startupErrors[0]}`);
			}
			for (const required of ORDINARY_COORDINATION_TOOLS) {
				if (!session.getToolDefinition(required)) {
					throw new ProtocolInvariantError(
						`started child Run is missing ordinary coordination surface ${required}`,
					);
				}
			}
		} catch (error) {
			session.dispose();
			throw error;
		}
		return session;
	}

	workflowSessionDirectory(): string {
		const ownerSessionDirectory = this.#ownerRuntime.session.sessionManager.getSessionDir();
		if (ownerSessionDirectory.length === 0) {
			throw new Error("Owner has no durable Pi session directory");
		}
		const encodedWorkflowId = Buffer.from(this.#ownerIdentity.workflowId, "utf8").toString(
			"base64url",
		);
		return join(ownerSessionDirectory, WORKFLOW_SESSION_DIRECTORY, encodedWorkflowId);
	}

	async #resolveSelectedTemplate(blueprint: ChildRunBlueprint): Promise<AgentTemplate | undefined> {
		const selectedName = blueprint.spawnInput.template;
		if (selectedName === undefined) return undefined;
		const projectTrusted = this.#projectTrustByCwd.get(blueprint.baseline.cwd) ?? false;
		const roots = this.#templateRoots
			? this.#templateRoots(blueprint.baseline.cwd, projectTrusted)
			: this.#defaultTemplateRoots(blueprint.baseline.cwd, projectTrusted);
		const discovery = await discoverAgentTemplates(roots);
		return selectAgentTemplateForRun(discovery, selectedName);
	}

	#defaultTemplateRoots(
		baselineCwd: string,
		projectTrusted: boolean,
	): readonly AgentTemplateRoot[] {
		return [
			{ scope: "package", path: join(this.#packageRoot, "agents") },
			{ scope: "pi-user", path: join(this.#ownerRuntime.services.agentDir, "agents") },
			{ scope: "user-agent-resource", path: join(homedir(), ".agents", "agents") },
			...(projectTrusted
				? [{ scope: "trusted-project", path: join(baselineCwd, ".agents", "agents") }]
				: []),
		];
	}

	#applyProjectContext(
		ordinaryContext: Array<{ path: string; content: string }>,
		configuration: EffectiveAgentRunConfiguration,
		agentId: string,
	): Array<{ path: string; content: string }> {
		const configured = configuration.projectContext;
		if (!configured) return ordinaryContext;
		const contextFile = {
			path: `<agent-configuration:${agentId}>`,
			content: configured.body,
		};
		return configured.mode === "replace" ? [contextFile] : [...ordinaryContext, contextFile];
	}

	async #validateWorkingDirectory(cwd: string): Promise<void> {
		const metadata = await stat(cwd);
		if (!metadata.isDirectory()) throw new Error("Configured working directory is not a directory");
	}

	#validateStartedSession(
		session: AgentSession,
		configuration: EffectiveAgentRunConfiguration,
	): void {
		const activeTools = new Set(session.getActiveToolNames());
		for (const required of configuration.tools) {
			if (!activeTools.has(required) || !session.getToolDefinition(required)) {
				throw new ProtocolInvariantError(
					`started child Run is missing required tool ${required}`,
				);
			}
		}
	}

	#hasInvalidSelectedSkill(
		diagnostics: ReturnType<AgentSessionServices["resourceLoader"]["getSkills"]>["diagnostics"],
		selectedSkills: readonly string[],
	): boolean {
		return diagnostics.some(
			(diagnostic) =>
				diagnostic.type === "error" ||
				(
					diagnostic.type === "collision" &&
					diagnostic.collision?.resourceType === "skill" &&
					selectedSkills.includes(diagnostic.collision.name)
				),
		);
	}

	#isCoordinationExtension(path: string, resolvedPath: string): boolean {
		return resolvedPath === this.#entryModulePath ||
			path === INLINE_PUBLIC_EXTENSION_PATH ||
			path.startsWith(CHILD_EXTENSION_PREFIX);
	}
}
