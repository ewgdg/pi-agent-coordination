import {
	type AgentSessionRuntime,
	SessionManager,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { AgentRecord } from "../coordination/agent-record.ts";
import { admitControlTransportPlatform } from "../control/control-platform.ts";
import { transcriptFromSessionFile } from "../pi-integration/session-manager-transcript.ts";
import type { AgentSpawnInput } from "../protocol/agent-spawn-input.ts";
import {
	resolveCommittedAgentRuntimeBlueprint,
	type AgentRuntimeBlueprint,
} from "../protocol/agent-runtime-blueprint.ts";
import type { ChildAgentIdentity } from "../protocol/child-identity.ts";
import {
	isModeratorIdentity,
	type ModeratorIdentity,
} from "../protocol/moderator-input.ts";
import type { OwnerIdentity } from "../protocol/owner-identity.ts";
import type { RuntimeConfigurationBaseline } from "../protocol/runtime-configuration.ts";
import {
	PiChildHostedRuntime,
} from "../process-runtime/pi-child-hosted-runtime.ts";
import {
	PiChildProcessRuntime,
	type StartPiChildProcessRuntimeOptions,
} from "../process-runtime/pi-child-process-runtime.ts";
import type { OwnerParticipantRequestHandlers } from "../process-runtime/remote-participant-control.ts";
import { discoverAgentTemplates } from "../templates/agent-template-discovery.ts";
import {
	selectAgentTemplateForRun,
	type AgentTemplate,
	type AgentTemplateRoot,
} from "../templates/agent-templates.ts";
import { AgentRuntimeSupervisor } from "./agent-runtime-supervisor.ts";
import {
	resolveChildRunBlueprint,
	type ChildRunParentSnapshot,
} from "./child-run-blueprint-resolver.ts";
import { workflowSessionDirectory } from "./workflow-session-directory.ts";

const COORDINATION_EXTENSION_PREFIXES = [
	"<inline:pi-agent-coordination-agent:",
	"<inline:pi-agent-coordination-moderator:",
	"<inline:pi-agent-coordination-activity:",
] as const;
const INLINE_PUBLIC_EXTENSION_PATH = "<inline:pi-agent-coordination>";

export type ProcessChildRunPreparation = Readonly<{
	agentId: string;
	parentSnapshot: ChildRunParentSnapshot;
	blueprint: AgentRuntimeBlueprint;
}>;

type ParticipantHandlers =
	| OwnerParticipantRequestHandlers<"ordinary">
	| OwnerParticipantRequestHandlers<"moderator">;

/**
 * Owns immutable child evidence and launches every non-Owner Runtime in a real
 * Pi process. Owner remains the only in-process Agent Runtime.
 */
export class ProcessChildSessionFactory {
	readonly #ownerRuntime: AgentSessionRuntime;
	readonly #ownerIdentity: OwnerIdentity;
	readonly #entryModulePath: string;
	readonly #packageRoot: string;
	readonly #templateRoots:
		| ((baselineCwd: string, projectTrusted: boolean) => readonly AgentTemplateRoot[])
		| undefined;
	readonly #ownerRequestHandlers: (
		role: AgentRuntimeBlueprint["role"],
		agentId: string,
	) => ParticipantHandlers;

	constructor(options: {
		ownerRuntime: AgentSessionRuntime;
		ownerIdentity: OwnerIdentity;
		entryModulePath: string;
		packageRoot?: string;
		templateRoots?(
			baselineCwd: string,
			projectTrusted: boolean,
		): readonly AgentTemplateRoot[];
		ownerRequestHandlers(
			role: AgentRuntimeBlueprint["role"],
			agentId: string,
		): ParticipantHandlers;
	}) {
		this.#ownerRuntime = options.ownerRuntime;
		this.#ownerIdentity = options.ownerIdentity;
		this.#entryModulePath = options.entryModulePath;
		this.#packageRoot = options.packageRoot ?? resolve(dirname(options.entryModulePath), "..");
		this.#templateRoots = options.templateRoots;
		this.#ownerRequestHandlers = options.ownerRequestHandlers;
	}

	admitProcessRuntimePlatform(): void {
		admitControlTransportPlatform();
	}

	snapshotParentRuntime(parent: AgentRecord): ChildRunParentSnapshot {
		if (parent.identity.agentId !== this.#ownerIdentity.agentId) {
			const transcript = parent.transcript.inspect();
			const blueprint = resolveCommittedAgentRuntimeBlueprint({
				sessionId: parent.identity.agentId,
				entries: transcript.entries,
			});
			return {
				baseline: configurationBaseline(blueprint.configuration),
				projectTrusted: blueprint.projectTrusted,
				skillSources: blueprint.skillSources.map(({ name, path }) => ({
					name,
					filePath: path,
				})),
			};
		}

		const snapshot = parent.host.effectiveRuntimeSnapshot();
		if (!snapshot) throw new Error("Parent Runtime snapshot is unavailable");
		return {
			baseline: {
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
			skillSources: this.#ownerSkillSources(snapshot.skills),
		};
	}

	async prepareOrdinaryRun(options: {
		agentId: string;
		parent: AgentRecord;
		spawnInput: AgentSpawnInput;
	}): Promise<ProcessChildRunPreparation> {
		const parentSnapshot = this.snapshotParentRuntime(options.parent);
		const template = await this.#resolveSelectedTemplate(
			parentSnapshot,
			options.spawnInput.template,
		);
		const blueprint = await resolveChildRunBlueprint({
			agentId: options.agentId,
			role: "ordinary",
			agentDir: this.#ownerRuntime.services.agentDir,
			parentSnapshot,
			...(template === undefined ? {} : { template }),
			...(options.spawnInput.config === undefined
				? {}
				: { overrides: options.spawnInput.config }),
		});
		return { agentId: options.agentId, parentSnapshot, blueprint };
	}

	async prepareModeratorRun(options: {
		agentId: string;
		parentSnapshot: ChildRunParentSnapshot;
	}): Promise<ProcessChildRunPreparation> {
		const template = await this.#resolveSelectedTemplate(
			options.parentSnapshot,
			"moderator",
		);
		const blueprint = await resolveChildRunBlueprint({
			agentId: options.agentId,
			role: "moderator",
			agentDir: this.#ownerRuntime.services.agentDir,
			parentSnapshot: options.parentSnapshot,
			...(template === undefined ? {} : { template }),
		});
		return {
			agentId: options.agentId,
			parentSnapshot: options.parentSnapshot,
			blueprint,
		};
	}

	createStagingSession(blueprint: AgentRuntimeBlueprint): SessionManager {
		return SessionManager.create(
			blueprint.configuration.cwd,
			this.workflowSessionDirectory(),
			{ id: blueprint.agentId },
		);
	}

	createAgentRecord(options: {
		identity: ChildAgentIdentity;
		blueprint: AgentRuntimeBlueprint;
		sessionPath: string;
	}): AgentRecord {
		return this.#createProcessRecord(options);
	}

	createModeratorRecord(options: {
		identity: ModeratorIdentity;
		blueprint: AgentRuntimeBlueprint;
		sessionPath: string;
	}): AgentRecord {
		return this.#createProcessRecord(options);
	}

	workflowSessionDirectory(): string {
		return workflowSessionDirectory(
			this.#ownerRuntime.session.sessionManager.getSessionDir(),
			this.#ownerIdentity.workflowId,
		);
	}

	#createProcessRecord(options: {
		identity: ChildAgentIdentity | ModeratorIdentity;
		blueprint: AgentRuntimeBlueprint;
		sessionPath: string;
	}): AgentRecord {
		const { identity, blueprint, sessionPath } = options;
		if (identity.agentId !== blueprint.agentId) {
			throw new Error("invariant_violation: Agent Identity and Runtime blueprint differ");
		}
		const identityRole = isModeratorIdentity(identity) ? "moderator" : "ordinary";
		if (identityRole !== blueprint.role) {
			throw new Error("invariant_violation: Agent Identity and Runtime blueprint roles differ");
		}
		const host = AgentRuntimeSupervisor.createChild({
			agentId: identity.agentId,
			startSession: async () => {
				const launch = await PiChildProcessRuntime.launch({
					workflowId: identity.workflowId,
					agentId: identity.agentId,
					role: blueprint.role,
					expectedSessionId: identity.agentId,
					sessionPath,
					configuration: blueprint.configuration,
					skillPaths: blueprint.skillSources.map(({ path }) => path),
					projectTrusted: blueprint.projectTrusted,
					agentsFiles: blueprint.agentsFiles,
					ownerRequestHandlers: this.#ownerRequestHandlers(
						blueprint.role,
						identity.agentId,
					) as StartPiChildProcessRuntimeOptions["ownerRequestHandlers"],
				});
				const runtime = new PiChildHostedRuntime(launch);
				return { runtime, ready: runtime.ready };
			},
		});
		return {
			identity,
			effectiveConfiguration: blueprint.configuration,
			host,
			transcript: transcriptFromSessionFile(sessionPath),
			children: [],
		};
	}

	async #resolveSelectedTemplate(
		parentSnapshot: ChildRunParentSnapshot,
		selectedName: string | undefined,
	): Promise<AgentTemplate | undefined> {
		if (selectedName === undefined) return undefined;
		const roots = this.#templateRoots
			? this.#templateRoots(
				parentSnapshot.baseline.cwd,
				parentSnapshot.projectTrusted,
			)
			: this.#defaultTemplateRoots(
				parentSnapshot.baseline.cwd,
				parentSnapshot.projectTrusted,
			);
		return selectAgentTemplateForRun(
			await discoverAgentTemplates(roots),
			selectedName,
		);
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

	#ownerSkillSources(selectedNames: readonly string[]): ChildRunParentSnapshot["skillSources"] {
		const loaded = this.#ownerRuntime.services.resourceLoader.getSkills().skills;
		return selectedNames.map((name) => {
			const matching = loaded.filter((skill) => skill.name === name);
			if (matching.length !== 1) {
				throw new Error(
					`Parent Runtime has ${matching.length} sources for selected skill ${name}`,
				);
			}
			return skillSource(matching[0]!);
		});
	}

	#isCoordinationExtension(path: string): boolean {
		return path === this.#entryModulePath ||
			path === INLINE_PUBLIC_EXTENSION_PATH ||
			COORDINATION_EXTENSION_PREFIXES.some((prefix) => path.startsWith(prefix));
	}
}

function configurationBaseline(
	configuration: AgentRuntimeBlueprint["configuration"],
): RuntimeConfigurationBaseline {
	return {
		cwd: configuration.cwd,
		model: configuration.model,
		thinking: configuration.thinking,
		tools: [...configuration.tools],
		skills: [...configuration.skills],
		extensions: [...configuration.extensions],
	};
}

function skillSource(skill: Skill): Pick<Skill, "name" | "filePath"> {
	return { name: skill.name, filePath: skill.filePath };
}
