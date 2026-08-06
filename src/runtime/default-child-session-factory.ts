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
	requireLiveServices,
	type AgentRecord,
} from "../coordination/agent-record.ts";
import { copyExtensionBindings } from "../pi-integration/extension-bindings.ts";
import { resolveAgentRunProjectTrust } from "../pi-integration/project-trust.ts";
import { resolveRunExtensions } from "../pi-integration/named-inline-extension-factories.ts";
import type { HumanPresentationBinding } from "../pi-integration/interactive-session-selection.ts";
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
import type { ChildAgentIdentity } from "../protocol/child-identity.ts";
import type { ModeratorIdentity } from "../protocol/moderator-input.ts";
import { InProcessAgentHost } from "./in-process-agent-host.ts";
import { discoverAgentTemplates } from "../templates/agent-template-discovery.ts";
import {
	selectAgentTemplateForRun,
	type AgentTemplate,
	type AgentTemplateRoot,
} from "../templates/agent-templates.ts";
import { workflowSessionDirectory } from "./workflow-session-directory.ts";
import {
	configureCoordinatedSession,
	type AutomaticGenerationReconciliationAdapter,
} from "../pi-integration/automatic-reconciliation.ts";

export const ORDINARY_COORDINATION_TOOLS = [
	"agent_message",
	"agent_control",
	"agent_observe",
	"agent_spawn",
	"ask_user_question",
] as const;

export const MODERATOR_COORDINATION_TOOLS = [
	"agent_message",
	"agent_control",
	"agent_observe",
	"ask_user_question",
	"moderator_control",
] as const;

const BUILT_IN_TOOL_NAMES = new Set(["bash", "edit", "find", "grep", "ls", "read", "write"]);
const CHILD_EXTENSION_PREFIX = "<inline:pi-agent-coordination-agent:";
const MODERATOR_EXTENSION_PREFIX = "<inline:pi-agent-coordination-moderator:";
const INLINE_PUBLIC_EXTENSION_PATH = "<inline:pi-agent-coordination>";

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
	readonly #hostResourceLoader: AgentSessionServices["resourceLoader"];
	readonly #ownerIdentity: OwnerIdentity;
	readonly #entryModulePath: string;
	readonly #packageRoot: string;
	readonly #childExtensionFactory: (agentId: string) => ExtensionFactory;
	readonly #moderatorExtensionFactory: (agentId: string) => ExtensionFactory;
	readonly #presentationExtensionFactory: (agentId: string) => ExtensionFactory;
	readonly #automaticGenerationReconciliation:
		| AutomaticGenerationReconciliationAdapter
		| undefined;
	readonly #templateRoots: ((baselineCwd: string, projectTrusted: boolean) => readonly AgentTemplateRoot[]) | undefined;
	readonly #projectTrustByCwd = new Map<string, boolean>();

	constructor(options: {
		ownerRuntime: AgentSessionRuntime;
		ownerIdentity: OwnerIdentity;
		entryModulePath: string;
		packageRoot: string;
		childExtensionFactory(agentId: string): ExtensionFactory;
		moderatorExtensionFactory(agentId: string): ExtensionFactory;
		presentationExtensionFactory(agentId: string): ExtensionFactory;
		automaticGenerationReconciliation?: AutomaticGenerationReconciliationAdapter;
		templateRoots?(baselineCwd: string, projectTrusted: boolean): readonly AgentTemplateRoot[];
	}) {
		this.#ownerRuntime = options.ownerRuntime;
		// Interactive selection temporarily rebinds ownerRuntime.services to a
		// presentation-only loader. Successor Runs still resolve inherited named
		// factories against the host registry admitted with the Workflow.
		this.#hostResourceLoader = options.ownerRuntime.services.resourceLoader;
		this.#ownerIdentity = options.ownerIdentity;
		this.#entryModulePath = options.entryModulePath;
		this.#packageRoot = options.packageRoot;
		this.#childExtensionFactory = options.childExtensionFactory;
		this.#moderatorExtensionFactory = options.moderatorExtensionFactory;
		this.#presentationExtensionFactory = options.presentationExtensionFactory;
		this.#automaticGenerationReconciliation =
			options.automaticGenerationReconciliation;
		this.#templateRoots = options.templateRoots;
	}

	snapshotRuntimeBaseline(parent: AgentRecord): RuntimeConfigurationBaseline {
		const parentSession = requireLiveSession(parent);
		const parentServices = requireLiveServices(parent);
		const model = parentSession.model;
		if (!model) throw new Error("Parent model is unavailable");
		if (!parentServices.modelRuntime.getModel(model.provider, model.id)) {
			throw new Error("Inherited model is unavailable");
		}
		const skills = parentServices.resourceLoader.getSkills().skills;
		const extensions = parentServices.resourceLoader
			.getExtensions()
			.extensions.filter((extension) => !this.#isCoordinationExtension(extension.path, extension.resolvedPath));
		const baseline = {
			// SessionManager cwd is the durable transcript header cwd. Services cwd is
			// the current Run's effective cwd and is what descendants must inherit.
			cwd: parentServices.cwd,
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
			parentServices.settingsManager.isProjectTrusted(),
		);
		return baseline;
	}

	createAgentRecord(options: {
		identity: ChildAgentIdentity;
		sessionManager: SessionManager;
		blueprint: ChildRunBlueprint;
		firstPrepared?: PreparedAgentRun;
	}): AgentRecord {
		const { identity, sessionManager, blueprint } = options;
		let firstPrepared = options.firstPrepared;
		let child!: AgentRecord;
		const host = InProcessAgentHost.createChild({
			sessionManager,
			startSession: async () => {
				const prepared = firstPrepared ?? await this.prepareRun(
					identity.agentId,
					blueprint,
				);
				firstPrepared = undefined;
				const session = await this.startSession({ sessionManager, prepared });
				child.services = prepared.services;
				child.effectiveConfiguration = prepared.configuration;
				return session;
			},
		});
		child = {
			identity,
			...(options.firstPrepared === undefined
				? {}
				: {
					services: options.firstPrepared.services,
					effectiveConfiguration: options.firstPrepared.configuration,
				}),
			host,
			children: [],
		};
		return child;
	}

	createModeratorRecord(options: {
		identity: ModeratorIdentity;
		sessionManager: SessionManager;
		firstPrepared?: PreparedAgentRun;
	}): AgentRecord {
		const { identity, sessionManager } = options;
		let firstPrepared = options.firstPrepared;
		let moderator!: AgentRecord;
		const host = InProcessAgentHost.createChild({
			sessionManager,
			startSession: async () => {
				const prepared = firstPrepared ?? await this.prepareModeratorRun(
					identity.agentId,
					identity.configuration.baseline,
				);
				firstPrepared = undefined;
				const session = await this.startSession({ sessionManager, prepared });
				moderator.services = prepared.services;
				moderator.effectiveConfiguration = prepared.configuration;
				return session;
			},
		});
		moderator = {
			identity,
			...(options.firstPrepared === undefined
				? {}
				: {
					services: options.firstPrepared.services,
					effectiveConfiguration: options.firstPrepared.configuration,
				}),
			host,
			children: [],
		};
		return moderator;
	}

	async prepareRun(agentId: string, blueprint: ChildRunBlueprint): Promise<PreparedAgentRun> {
		const template = await this.#resolveSelectedTemplate(blueprint);
		return this.#prepareConfiguredRun({
			agentId,
			baseline: blueprint.baseline,
			template,
			overrides: blueprint.spawnInput.config,
			fixedTools: ORDINARY_COORDINATION_TOOLS,
			extensionFactory: this.#childExtensionFactory(agentId),
			extensionName: `pi-agent-coordination-agent:${agentId}`,
		});
	}

	async prepareModeratorRun(
		agentId: string,
		baseline: RuntimeConfigurationBaseline,
	): Promise<PreparedAgentRun> {
		const template = await this.#resolveTemplate(baseline, "moderator");
		return this.#prepareConfiguredRun({
			agentId,
			baseline,
			template,
			fixedTools: MODERATOR_COORDINATION_TOOLS,
			extensionFactory: this.#moderatorExtensionFactory(agentId),
			extensionName: `pi-agent-coordination-moderator:${agentId}`,
		});
	}

	async #prepareConfiguredRun(options: {
		agentId: string;
		baseline: RuntimeConfigurationBaseline;
		template: AgentTemplate | undefined;
		overrides?: AgentSpawnInput["config"];
		fixedTools: readonly string[];
		extensionFactory: ExtensionFactory;
		extensionName: string;
	}): Promise<PreparedAgentRun> {
		const configuration = resolveAgentRunConfiguration({
			baseline: options.baseline,
			template: options.template,
			overrides: options.overrides,
			fixedTools: options.fixedTools,
		});
		const runExtensions = resolveRunExtensions(
			this.#hostResourceLoader,
			configuration.extensions,
		);
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
				additionalExtensionPaths: [...runExtensions.filePaths],
				extensionFactories: [
					...runExtensions.inlineFactories,
					{
						name: options.extensionName,
						hidden: true,
						factory: options.extensionFactory,
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
						options.agentId,
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
			throw new Error("Agent resource validation failed");
		}
		const loadedSkillNames = new Set(skills.skills.map(({ name }) => name));
		for (const skillName of configuration.skills) {
			if (!loadedSkillNames.has(skillName)) {
				throw new Error(`Agent skill resource is unavailable: ${skillName}`);
			}
		}
		const extensionTools = new Set(
			extensions.extensions.flatMap((extension) => [...extension.tools.keys()]),
		);
		for (const toolName of configuration.tools) {
			if (!BUILT_IN_TOOL_NAMES.has(toolName) && !extensionTools.has(toolName)) {
				throw new Error(`Agent tool resource is unavailable: ${toolName}`);
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
			configureCoordinatedSession(
				session,
				this.#automaticGenerationReconciliation,
			);
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
				throw new Error(`Agent extension startup failed: ${startupErrors[0]}`);
			}
		} catch (error) {
			session.dispose();
			throw error;
		}
		return session;
	}

	async createPresentationBinding(record: AgentRecord): Promise<HumanPresentationBinding> {
		const agentId = record.identity.agentId;
		const services = await createAgentSessionServices({
			cwd: record.host.sessionManager.getCwd(),
			agentDir: this.#ownerRuntime.services.agentDir,
			modelRuntime: this.#ownerRuntime.services.modelRuntime,
			settingsManager: this.#ownerRuntime.services.settingsManager,
			resourceLoaderOptions: {
				noContextFiles: true,
				noPromptTemplates: true,
				noSkills: true,
				noThemes: true,
				noExtensions: true,
				extensionFactories: [{
					name: `pi-agent-coordination-presentation:${agentId}`,
					hidden: true,
					factory: this.#presentationExtensionFactory(agentId),
				}],
			},
		});
		const created = await createAgentSessionFromServices({
			services,
			sessionManager: record.host.sessionManager,
			noTools: "builtin",
		});
		const session = created.session;
		try {
			await session.bindExtensions(
				copyExtensionBindings(this.#ownerRuntime.session, session),
			);
			session.setActiveToolsByName([]);
		} catch (error) {
			session.dispose();
			throw error;
		}
		return {
			agentId,
			session,
			services,
			diagnostics: services.diagnostics,
			release: () => session.dispose(),
		};
	}

	workflowSessionDirectory(): string {
		return workflowSessionDirectory(
			this.#ownerRuntime.session.sessionManager.getSessionDir(),
			this.#ownerIdentity.workflowId,
		);
	}

	async #resolveSelectedTemplate(blueprint: ChildRunBlueprint): Promise<AgentTemplate | undefined> {
		const selectedName = blueprint.spawnInput.template;
		if (selectedName === undefined) return undefined;
		return this.#resolveTemplate(blueprint.baseline, selectedName);
	}

	async #resolveTemplate(
		baseline: RuntimeConfigurationBaseline,
		selectedName: string,
	): Promise<AgentTemplate | undefined> {
		const projectTrusted = this.#projectTrustByCwd.get(baseline.cwd) ?? false;
		const roots = this.#templateRoots
			? this.#templateRoots(baseline.cwd, projectTrusted)
			: this.#defaultTemplateRoots(baseline.cwd, projectTrusted);
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
						`started Agent Run is missing required tool ${required}`,
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
			path.startsWith(CHILD_EXTENSION_PREFIX) ||
			path.startsWith(MODERATOR_EXTENSION_PREFIX);
	}
}
