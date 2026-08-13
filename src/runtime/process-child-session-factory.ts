import {
	type AgentSessionRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { dirname, resolve } from "node:path";

import type { AgentRecord } from "../coordination/agent-record.ts";
import { admitControlTransportPlatform } from "../control/control-platform.ts";
import { transcriptFromSessionFile } from "../pi-integration/session-manager-transcript.ts";
import type { AgentSpawnInput } from "../protocol/agent-spawn-input.ts";
import type { ChildAgentIdentity } from "../protocol/child-identity.ts";
import {
	isModeratorIdentity,
	type ModeratorIdentity,
} from "../protocol/moderator-input.ts";
import type { OwnerIdentity } from "../protocol/owner-identity.ts";
import {
	PiChildHostedRuntime,
} from "../process-runtime/pi-child-hosted-runtime.ts";
import {
	PiChildProcessRuntime,
	type StartPiChildProcessRuntimeOptions,
} from "../process-runtime/pi-child-process-runtime.ts";
import type { OwnerParticipantRequestHandlers } from "../process-runtime/remote-participant-control.ts";
import {
	defaultAgentTemplateRoots,
	discoverAgentTemplates,
} from "../templates/agent-template-discovery.ts";
import {
	createAgentTemplateCatalogue,
	selectAgentTemplateForRun,
	type AgentTemplate,
	type AgentTemplateCatalogueEntry,
	type AgentTemplatePromptContext,
	type AgentTemplateRoot,
} from "../templates/agent-templates.ts";
import { AgentRuntimeSupervisor } from "./agent-runtime-supervisor.ts";
import {
	prepareChildRuntime,
	type AgentRuntimeRole,
	type PreparedChildRuntime,
	type ResolvedParentRuntime,
} from "./child-runtime-preparation.ts";
import { workflowSessionDirectory } from "./workflow-session-directory.ts";

const COORDINATION_EXTENSION_PREFIXES = [
	"<inline:pi-agent-coordination-agent:",
	"<inline:pi-agent-coordination-moderator:",
	"<inline:pi-agent-coordination-activity:",
] as const;
const INLINE_PUBLIC_EXTENSION_PATH = "<inline:pi-agent-coordination>";

export type ProcessChildRunPreparation = PreparedChildRuntime;

type ParticipantHandlers =
	| OwnerParticipantRequestHandlers<"ordinary">
	| OwnerParticipantRequestHandlers<"moderator">;

/** Launches every non-Owner Runtime in a fresh Pi process. */
export class ProcessChildSessionFactory {
	readonly #ownerRuntime: AgentSessionRuntime;
	readonly #ownerIdentity: OwnerIdentity;
	readonly #entryModulePath: string;
	readonly #packageRoot: string;
	readonly #templateRoots:
		| ((parentCwd: string, projectTrusted: boolean) => readonly AgentTemplateRoot[])
		| undefined;
	readonly #resolveAgent: (agentId: string) => AgentRecord | undefined;
	readonly #ownerRequestHandlers: (
		role: AgentRuntimeRole,
		agentId: string,
	) => ParticipantHandlers;

	constructor(options: {
		ownerRuntime: AgentSessionRuntime;
		ownerIdentity: OwnerIdentity;
		entryModulePath: string;
		packageRoot?: string;
		templateRoots?(
			parentCwd: string,
			projectTrusted: boolean,
		): readonly AgentTemplateRoot[];
		resolveAgent(agentId: string): AgentRecord | undefined;
		ownerRequestHandlers(
			role: AgentRuntimeRole,
			agentId: string,
		): ParticipantHandlers;
	}) {
		this.#ownerRuntime = options.ownerRuntime;
		this.#ownerIdentity = options.ownerIdentity;
		this.#entryModulePath = options.entryModulePath;
		this.#packageRoot = options.packageRoot ?? resolve(dirname(options.entryModulePath), "..");
		this.#templateRoots = options.templateRoots;
		this.#resolveAgent = options.resolveAgent;
		this.#ownerRequestHandlers = options.ownerRequestHandlers;
	}

	admitProcessRuntimePlatform(): void {
		admitControlTransportPlatform();
	}

	/**
	 * Dynamic preparation is deliberate product behavior: every new Runtime
	 * re-resolves its current parent ancestry, selected Template, resources,
	 * trust, and Project Context. Never persist or reuse this resolved launch
	 * specification for a later Runtime unless the product semantics are
	 * explicitly changed at the user's request.
	 */
	async prepareOrdinaryRun(options: {
		agentId: string;
		parent: AgentRecord;
		spawnInput: AgentSpawnInput;
	}): Promise<ProcessChildRunPreparation> {
		return this.#prepareOrdinaryRun(options, new Set());
	}

	async prepareModeratorRun(options: {
		agentId: string;
	}): Promise<ProcessChildRunPreparation> {
		const owner = this.#resolveAgent(this.#ownerIdentity.agentId);
		if (!owner) throw new Error("invariant_violation: Workflow Owner is unavailable");
		const parentRuntime = await this.#resolveCurrentRuntime(owner, new Set());
		const template = await this.#resolveSelectedTemplate(parentRuntime, "moderator");
		return prepareChildRuntime({
			agentId: options.agentId,
			role: "moderator",
			agentDir: this.#ownerRuntime.services.agentDir,
			parentRuntime,
			isModelAvailable: (model) => this.#isModelAvailable(model),
			...(template === undefined ? {} : { template }),
		});
	}

	createStagingSession(prepared: PreparedChildRuntime): SessionManager {
		return SessionManager.create(
			prepared.configuration.cwd,
			this.workflowSessionDirectory(),
			{ id: prepared.agentId },
		);
	}

	createAgentRecord(options: {
		identity: ChildAgentIdentity;
		spawnInput: AgentSpawnInput;
		parent: AgentRecord;
		initialPreparation?: PreparedChildRuntime;
		sessionPath: string;
	}): AgentRecord {
		const { identity, spawnInput, parent, sessionPath } = options;
		let firstPreparation = options.initialPreparation;
		let record!: AgentRecord;
		const host = AgentRuntimeSupervisor.createChild({
			agentId: identity.agentId,
			startSession: async () => {
				const prepared = firstPreparation ?? await this.prepareOrdinaryRun({
					agentId: identity.agentId,
					parent,
					spawnInput,
				});
				firstPreparation = undefined;
				record.effectiveConfiguration = prepared.configuration;
				return this.#launchPreparedRuntime(identity, prepared, sessionPath);
			},
		});
		record = {
			identity,
			creationInput: spawnInput,
			...(options.initialPreparation === undefined
				? {}
				: { effectiveConfiguration: options.initialPreparation.configuration }),
			host,
			transcript: transcriptFromSessionFile(sessionPath),
			children: [],
		};
		return record;
	}

	createModeratorRecord(options: {
		identity: ModeratorIdentity;
		initialPreparation?: PreparedChildRuntime;
		sessionPath: string;
	}): AgentRecord {
		const { identity, sessionPath } = options;
		let firstPreparation = options.initialPreparation;
		let record!: AgentRecord;
		const host = AgentRuntimeSupervisor.createChild({
			agentId: identity.agentId,
			startSession: async () => {
				const prepared = firstPreparation ?? await this.prepareModeratorRun({
					agentId: identity.agentId,
				});
				firstPreparation = undefined;
				record.effectiveConfiguration = prepared.configuration;
				return this.#launchPreparedRuntime(identity, prepared, sessionPath);
			},
		});
		record = {
			identity,
			...(options.initialPreparation === undefined
				? {}
				: { effectiveConfiguration: options.initialPreparation.configuration }),
			host,
			transcript: transcriptFromSessionFile(sessionPath),
			children: [],
		};
		return record;
	}

	workflowSessionDirectory(): string {
		return workflowSessionDirectory(
			this.#ownerRuntime.session.sessionManager.getSessionDir(),
			this.#ownerIdentity.workflowId,
		);
	}

	async availableTemplatesFor(record: AgentRecord): Promise<AgentTemplatePromptContext> {
		const admittedRuntime = record.host.effectiveRuntimeSnapshot();
		if (admittedRuntime) {
			return {
				currentRuntime: {
					model: admittedRuntime.model,
					thinking: admittedRuntime.thinking,
				},
				templates: await this.#discoverTemplateCatalogueForRuntime(
					admittedRuntime.cwd,
					admittedRuntime.projectTrusted,
				),
			};
		}
		const parentRuntime = await this.#resolveCurrentRuntime(record, new Set());
		return {
			currentRuntime: {
				model: parentRuntime.configuration.model,
				thinking: parentRuntime.configuration.thinking,
			},
			templates: await this.#discoverTemplateCatalogue(parentRuntime),
		};
	}

	async #discoverTemplateCatalogue(
		parentRuntime: ResolvedParentRuntime,
	): Promise<readonly AgentTemplateCatalogueEntry[]> {
		return this.#discoverTemplateCatalogueForRuntime(
			parentRuntime.configuration.cwd,
			parentRuntime.projectTrusted,
		);
	}

	async #discoverTemplateCatalogueForRuntime(
		cwd: string,
		projectTrusted: boolean,
	): Promise<readonly AgentTemplateCatalogueEntry[]> {
		const discovery = await discoverAgentTemplates(this.#resolveTemplateRoots(cwd, projectTrusted));
		return createAgentTemplateCatalogue(
			discovery.templates.values(),
			(model) => this.#isModelAvailable(model),
		);
	}

	async #prepareOrdinaryRun(
		options: {
			agentId: string;
			parent: AgentRecord;
			spawnInput: AgentSpawnInput;
		},
		resolving: Set<string>,
	): Promise<PreparedChildRuntime> {
		const parentRuntime = await this.#resolveCurrentRuntime(options.parent, resolving);
		const template = await this.#resolveSelectedTemplate(
			parentRuntime,
			options.spawnInput.template,
		);
		return prepareChildRuntime({
			agentId: options.agentId,
			role: "ordinary",
			agentDir: this.#ownerRuntime.services.agentDir,
			parentRuntime,
			isModelAvailable: (model) => this.#isModelAvailable(model),
			...(template === undefined ? {} : { template }),
			...(options.spawnInput.config === undefined
				? {}
				: { overrides: options.spawnInput.config }),
		});
	}

	async #resolveCurrentRuntime(
		record: AgentRecord,
		resolving: Set<string>,
	): Promise<ResolvedParentRuntime> {
		const admittedSnapshot = record.host.effectiveRuntimeSnapshot();
		if (admittedSnapshot) {
			const snapshot = await record.host.synchronizeRuntimeState();
			if (snapshot.sessionId !== record.identity.agentId) {
				throw new Error(
					"invariant_violation: Parent Runtime snapshot does not match Agent Identity",
				);
			}
			return {
				configuration: {
					cwd: snapshot.cwd,
					model: snapshot.model,
					thinking: snapshot.thinking,
					tools: [...snapshot.tools],
					skills: [...snapshot.skills],
					extensions: snapshot.fileExtensionPaths.filter(
						(path) => !this.#isCoordinationExtension(path),
					),
				},
				projectTrusted: snapshot.projectTrusted,
				skillSources: snapshot.skillSources.map(({ name, filePath }) => ({
					name,
					filePath,
				})),
			};
		}
		if (record.identity.agentId === this.#ownerIdentity.agentId) {
			return this.#resolveCurrentOwnerRuntime();
		}
		if (isModeratorIdentity(record.identity)) {
			throw new Error("Moderator cannot be an Agent Spawn parent");
		}
		if (resolving.has(record.identity.agentId)) {
			throw new Error("invariant_violation: Agent Runtime preparation ancestry contains a cycle");
		}
		if (!record.creationInput || record.identity.directSpawnerAgentId === null) {
			throw new Error("invariant_violation: Child Agent creation input is unavailable");
		}
		const parent = this.#resolveAgent(record.identity.directSpawnerAgentId);
		if (!parent) {
			throw new Error("invariant_violation: Child Agent Direct Spawner is unavailable");
		}
		resolving.add(record.identity.agentId);
		try {
			const prepared = await this.#prepareOrdinaryRun({
				agentId: record.identity.agentId,
				parent,
				spawnInput: record.creationInput,
			}, resolving);
			return {
				configuration: prepared.configuration,
				projectTrusted: prepared.projectTrusted,
				skillSources: prepared.skillSources.map(({ name, path }) => ({
					name,
					filePath: path,
				})),
			};
		} finally {
			resolving.delete(record.identity.agentId);
		}
	}

	#resolveCurrentOwnerRuntime(): ResolvedParentRuntime {
		const session = this.#ownerRuntime.session;
		const model = session.model;
		if (!model) throw new Error("Parent Owner Runtime model is unavailable");
		const skills = this.#ownerRuntime.services.resourceLoader.getSkills().skills;
		return {
			configuration: {
				cwd: this.#ownerRuntime.services.cwd,
				model: { provider: model.provider, modelId: model.id },
				thinking: session.thinkingLevel,
				tools: session.getActiveToolNames(),
				skills: skills.map(({ name }) => name),
				extensions: this.#ownerRuntime.services.resourceLoader
					.getExtensions()
					.extensions.map(({ resolvedPath }) => resolvedPath)
					.filter((path) => !this.#isCoordinationExtension(path)),
			},
			projectTrusted: this.#ownerRuntime.services.settingsManager.isProjectTrusted(),
			skillSources: skills.map(({ name, filePath }) => ({ name, filePath })),
		};
	}

	async #launchPreparedRuntime(
		identity: ChildAgentIdentity | ModeratorIdentity,
		prepared: PreparedChildRuntime,
		sessionPath: string,
	) {
		if (identity.agentId !== prepared.agentId) {
			throw new Error("invariant_violation: Agent Identity and Runtime preparation differ");
		}
		const identityRole = isModeratorIdentity(identity) ? "moderator" : "ordinary";
		if (identityRole !== prepared.role) {
			throw new Error("invariant_violation: Agent Identity and Runtime preparation roles differ");
		}
		const launch = await PiChildProcessRuntime.launch({
			workflowId: identity.workflowId,
			agentId: identity.agentId,
			role: prepared.role,
			expectedSessionId: identity.agentId,
			sessionPath,
			configuration: prepared.configuration,
			skillPaths: prepared.skillSources.map(({ path }) => path),
			projectTrusted: prepared.projectTrusted,
			agentDir: this.#ownerRuntime.services.agentDir,
			agentsFiles: prepared.agentsFiles,
			ownerRequestHandlers: this.#ownerRequestHandlers(
				prepared.role,
				identity.agentId,
			) as StartPiChildProcessRuntimeOptions["ownerRequestHandlers"],
		});
		const runtime = new PiChildHostedRuntime(launch);
		return { runtime, ready: runtime.ready };
	}

	async #resolveSelectedTemplate(
		parentRuntime: ResolvedParentRuntime,
		selectedName: string | undefined,
	): Promise<AgentTemplate | undefined> {
		if (selectedName === undefined) return undefined;
		return selectAgentTemplateForRun(
			await discoverAgentTemplates(this.#resolveTemplateRoots(
				parentRuntime.configuration.cwd,
				parentRuntime.projectTrusted,
			)),
			selectedName,
		);
	}

	#resolveTemplateRoots(
		parentCwd: string,
		projectTrusted: boolean,
	): readonly AgentTemplateRoot[] {
		return this.#templateRoots
			? this.#templateRoots(parentCwd, projectTrusted)
			: defaultAgentTemplateRoots({
				packageRoot: this.#packageRoot,
				agentDir: this.#ownerRuntime.services.agentDir,
				parentCwd,
				projectTrusted,
			});
	}

	#isModelAvailable(model: Readonly<{ provider: string; modelId: string }>): boolean {
		return this.#ownerRuntime.services.modelRuntime.getModel(model.provider, model.modelId) !== undefined;
	}

	#isCoordinationExtension(path: string): boolean {
		return path === this.#entryModulePath ||
			path === INLINE_PUBLIC_EXTENSION_PATH ||
			COORDINATION_EXTENSION_PREFIXES.some((prefix) => path.startsWith(prefix));
	}
}
