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
import { isAbsolute, join } from "node:path";

import type { AgentRecord } from "../coordination/agent-record.ts";
import {
	createPiNativeProjectionHost,
	type PiNativeAgentProjection,
	type PiNativeProjectionHost,
} from "../pi-integration/native-agent-projection.ts";
import { resolveAgentRunProjectTrust } from "../pi-integration/project-trust.ts";
import { transcriptFromSessionManager } from "../pi-integration/session-manager-transcript.ts";
import {
	holdModelRunsUntilProjectionAdmission,
	type ModelRunAdmission,
} from "../pi-integration/run-admission.ts";
import { resolveRunExtensions } from "../pi-integration/named-inline-extension-factories.ts";
import type { AgentSpawnInput } from "../protocol/agent-spawn-input.ts";
import type { AgentRuntimeBlueprint } from "../protocol/agent-runtime-blueprint.ts";
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
import {
	AgentRuntimeSupervisor,
	type StartedAgentRuntime,
} from "./agent-runtime-supervisor.ts";
import { InProcessHostedRuntime } from "./in-process-hosted-runtime.ts";
import { SerialLane } from "./serial-lane.ts";
import { discoverAgentTemplates } from "../templates/agent-template-discovery.ts";
import {
	selectAgentTemplateForRun,
	type AgentTemplate,
	type AgentTemplateRoot,
} from "../templates/agent-templates.ts";
import { workflowSessionDirectory } from "./workflow-session-directory.ts";
import {
	applyCoordinatedSessionRuntimePolicy,
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
const ACTIVITY_EXTENSION_PREFIX = "<inline:pi-agent-coordination-activity:";
const INLINE_PUBLIC_EXTENSION_PATH = "<inline:pi-agent-coordination>";
const modelRuntimeServiceLanes = new WeakMap<object, SerialLane>();

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
	readonly #activityExtensionFactory: (agentId: string) => ExtensionFactory;
	readonly #projectionHost: PiNativeProjectionHost;
	readonly #modelRuntimeServiceLane: SerialLane;
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
		activityExtensionFactory(agentId: string): ExtensionFactory;
		projectionHost?: PiNativeProjectionHost;
		automaticGenerationReconciliation?: AutomaticGenerationReconciliationAdapter;
		templateRoots?(baselineCwd: string, projectTrusted: boolean): readonly AgentTemplateRoot[];
	}) {
		this.#ownerRuntime = options.ownerRuntime;
		// Successor Runs resolve inherited named factories against the resource
		// registry admitted with the continuously bound Owner Workflow.
		this.#hostResourceLoader = options.ownerRuntime.services.resourceLoader;
		this.#ownerIdentity = options.ownerIdentity;
		this.#entryModulePath = options.entryModulePath;
		this.#packageRoot = options.packageRoot;
		this.#childExtensionFactory = options.childExtensionFactory;
		this.#moderatorExtensionFactory = options.moderatorExtensionFactory;
		this.#activityExtensionFactory = options.activityExtensionFactory;
		this.#projectionHost = options.projectionHost ?? createPiNativeProjectionHost({
			ownerRuntime: options.ownerRuntime,
		});
		this.#modelRuntimeServiceLane = modelRuntimeServiceLane(
			options.ownerRuntime.services.modelRuntime,
		);
		this.#automaticGenerationReconciliation =
			options.automaticGenerationReconciliation;
		this.#templateRoots = options.templateRoots;
	}

	snapshotRuntimeBaseline(parent: AgentRecord): RuntimeConfigurationBaseline {
		const snapshot = parent.host.effectiveRuntimeSnapshot();
		if (!snapshot) throw new Error("Parent Runtime snapshot is unavailable");
		if (!this.#ownerRuntime.services.modelRuntime.getModel(
			snapshot.model.provider,
			snapshot.model.modelId,
		)) {
			throw new Error("Inherited model is unavailable");
		}
		const baseline = {
			cwd: snapshot.cwd,
			model: snapshot.model,
			thinking: snapshot.thinking,
			tools: snapshot.tools.filter(
				(name) =>
					!ORDINARY_COORDINATION_TOOLS.includes(
						name as (typeof ORDINARY_COORDINATION_TOOLS)[number],
					),
			),
			skills: snapshot.skills,
			extensions: snapshot.fileExtensionPaths.filter(
				(path) => !this.#isCoordinationExtension(path, path),
			),
		} satisfies RuntimeConfigurationBaseline;
		this.#projectTrustByCwd.set(baseline.cwd, snapshot.projectTrusted);
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
		const host = AgentRuntimeSupervisor.createChild({
			agentId: identity.agentId,
			startSession: async () => {
				const prepared = firstPrepared ?? await this.prepareRun(
					identity.agentId,
					blueprint,
				);
				firstPrepared = undefined;
				const startedRun = await this.startSession({ sessionManager, prepared });
				child.effectiveConfiguration = prepared.configuration;
				return startedRun;
			},
		});
		child = {
			identity,
			...(options.firstPrepared === undefined
				? {}
				: { effectiveConfiguration: options.firstPrepared.configuration }),
			host,
			transcript: transcriptFromSessionManager(sessionManager),
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
		const host = AgentRuntimeSupervisor.createChild({
			agentId: identity.agentId,
			startSession: async () => {
				const prepared = firstPrepared ?? await this.prepareModeratorRun(
					identity.agentId,
					identity.configuration.baseline,
				);
				firstPrepared = undefined;
				const startedRun = await this.startSession({ sessionManager, prepared });
				moderator.effectiveConfiguration = prepared.configuration;
				return startedRun;
			},
		});
		moderator = {
			identity,
			...(options.firstPrepared === undefined
				? {}
				: { effectiveConfiguration: options.firstPrepared.configuration }),
			host,
			transcript: transcriptFromSessionManager(sessionManager),
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
		const services = await this.#modelRuntimeServiceLane.run(() =>
			createAgentSessionServices({
				cwd: configuration.cwd,
				agentDir: this.#ownerRuntime.services.agentDir,
				modelRuntime: this.#ownerRuntime.services.modelRuntime,
				settingsManager: this.#createIsolatedSettingsManager(
					configuration.cwd,
					projectTrusted,
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
						// Install the native dock before a user session_start handler can
						// pause initialization on a dialog or other interactive surface.
						{
							name: `pi-agent-coordination-activity:${options.agentId}`,
							hidden: true,
							factory: this.#activityExtensionFactory(options.agentId),
						},
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
			}),
		);
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

	runtimeBlueprintForPreparedRun(options: {
		agentId: string;
		role: AgentRuntimeBlueprint["role"];
		prepared: PreparedAgentRun;
	}): AgentRuntimeBlueprint {
		const { agentId, role, prepared } = options;
		const loadedSkills = prepared.services.resourceLoader.getSkills().skills;
		const skillSources = prepared.configuration.skills.map((name) => {
			const matching = loadedSkills.filter((skill) => skill.name === name);
			if (matching.length !== 1) {
				throw new ProtocolInvariantError(
					`prepared Agent Runtime has ${matching.length} sources for selected skill ${name}`,
				);
			}
			return { name, path: matching[0]!.filePath };
		});
		return {
			agentId,
			role,
			configuration: {
				...prepared.configuration,
				// Inline factories are reconstructed by Pi's own CLI composition root;
				// only canonical file-backed resources cross the process boundary.
				extensions: prepared.configuration.extensions.filter(isAbsolute),
			},
			projectTrusted: prepared.services.settingsManager.isProjectTrusted(),
			skillSources,
			agentsFiles: prepared.services.resourceLoader
				.getAgentsFiles()
				.agentsFiles.map(({ path, content }) => ({ path, content })),
		};
	}

	async startSession(options: {
		sessionManager: SessionManager;
		prepared: PreparedAgentRun;
	}): Promise<StartedAgentRuntime> {
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
		let projection: PiNativeAgentProjection | undefined;
		let modelRunAdmission: ModelRunAdmission | undefined;
		let ready: Promise<void> | undefined;
		try {
			configureCoordinatedSession(
				session,
				this.#automaticGenerationReconciliation,
			);
			this.#validateStartedSession(session, prepared.configuration);
			modelRunAdmission = holdModelRunsUntilProjectionAdmission(session);
			// The Agent Runtime's InteractiveMode owns extension binding. This gives
			// every prepared Runtime one native editor/footer/UI lifecycle and emits
			// session_start once, while model work remains behind the readiness gate.
			projection = await this.#projectionHost.createProjection({
				session,
				services: prepared.services,
				exposeWhileInitializing: true,
			});
			ready = projection.ready().then(
				() => {
					// Pi may persist an auto-detected theme during InteractiveMode init;
					// SettingsManager.save() rebuilds effective settings and drops process-local
					// overrides, so reassert policy immediately before model admission.
					applyCoordinatedSessionRuntimePolicy(session);
					modelRunAdmission!.admit();
				},
				(error) => {
					modelRunAdmission!.cancel(error);
					throw error;
				},
			);
		} catch (error) {
			modelRunAdmission?.cancel(error);
			const cleanupErrors: unknown[] = [error];
			try {
				await projection?.dispose();
			} catch (cleanupError) {
				cleanupErrors.push(cleanupError);
			}
			try {
				session.dispose();
			} catch (cleanupError) {
				cleanupErrors.push(cleanupError);
			}
			if (cleanupErrors.length > 1) {
				throw new AggregateError(cleanupErrors, "Agent projection startup cleanup failed");
			}
			throw error;
		}
		return {
			runtime: InProcessHostedRuntime.fromSession({
				session,
				services: prepared.services,
				projection,
			}),
			ready,
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

	#createIsolatedSettingsManager(
		cwd: string,
		projectTrusted = this.#projectTrustByCwd.get(cwd) ??
			this.#ownerRuntime.services.settingsManager.isProjectTrusted(),
	): SettingsManager {
		const source = SettingsManager.create(
			cwd,
			this.#ownerRuntime.services.agentDir,
			{ projectTrusted },
		);
		const isolated = SettingsManager.inMemory(
			source.getGlobalSettings(),
			{ projectTrusted: source.isProjectTrusted() },
		);
		isolated.applyOverrides(source.getProjectSettings());
		return isolated;
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
			path.startsWith(MODERATOR_EXTENSION_PREFIX) ||
			path.startsWith(ACTIVITY_EXTENSION_PREFIX);
	}
}

function modelRuntimeServiceLane(modelRuntime: object): SerialLane {
	let lane = modelRuntimeServiceLanes.get(modelRuntime);
	if (!lane) {
		lane = new SerialLane();
		modelRuntimeServiceLanes.set(modelRuntime, lane);
	}
	return lane;
}
