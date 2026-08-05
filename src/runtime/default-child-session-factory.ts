import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	type AgentSession,
	type AgentSessionRuntime,
	type AgentSessionServices,
	type ExtensionFactory,
	type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

import {
	requireLiveSession,
	type AgentRecord,
} from "../coordination/agent-record.ts";
import { copyExtensionBindings } from "../pi-integration/extension-bindings.ts";
import { ProtocolInvariantError } from "../protocol/identities.ts";
import type {
	OwnerIdentity,
	RuntimeConfigurationBaseline,
} from "../protocol/owner-identity.ts";

export const ORDINARY_COORDINATION_TOOLS = [
	"agent_message",
	"agent_observe",
	"agent_spawn",
	"ask_user_question",
] as const;

const BUILT_IN_TOOL_NAMES = new Set(["bash", "edit", "find", "grep", "ls", "read", "write"]);
const CHILD_EXTENSION_PREFIX = "<inline:pi-agent-coordination-agent:";
const INLINE_PUBLIC_EXTENSION_PATH = "<inline:pi-agent-coordination>";
const WORKFLOW_SESSION_DIRECTORY = "pi-agent-coordination";

export type InheritedRuntime = {
	baseline: RuntimeConfigurationBaseline;
	skillPaths: string[];
	extensionPaths: string[];
};

export class DefaultChildSessionFactory {
	readonly #ownerRuntime: AgentSessionRuntime;
	readonly #ownerIdentity: OwnerIdentity;
	readonly #entryModulePath: string;
	readonly #childExtensionFactory: (agentId: string) => ExtensionFactory;

	constructor(options: {
		ownerRuntime: AgentSessionRuntime;
		ownerIdentity: OwnerIdentity;
		entryModulePath: string;
		childExtensionFactory(agentId: string): ExtensionFactory;
	}) {
		this.#ownerRuntime = options.ownerRuntime;
		this.#ownerIdentity = options.ownerIdentity;
		this.#entryModulePath = options.entryModulePath;
		this.#childExtensionFactory = options.childExtensionFactory;
	}

	snapshotInheritedRuntime(parent: AgentRecord): InheritedRuntime {
		const parentSession = requireLiveSession(parent);
		const model = parentSession.model;
		if (!model) throw new Error("Parent model is unavailable");
		if (!parent.services.modelRuntime.getModel(model.provider, model.id)) {
			throw new Error("Inherited model is unavailable");
		}
		const skills = parent.services.resourceLoader.getSkills().skills;
		const extensions = parent.services.resourceLoader
			.getExtensions()
			.extensions.filter(
				// The public bootstrap may be file-loaded or injected inline. Children
				// inherit ordinary resources, never another Owner bootstrap.
				(extension) =>
					extension.resolvedPath !== this.#entryModulePath &&
					extension.path !== INLINE_PUBLIC_EXTENSION_PATH &&
					!extension.path.startsWith(CHILD_EXTENSION_PREFIX),
			);
		return {
			baseline: {
				cwd: parentSession.sessionManager.getCwd(),
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
			},
			skillPaths: skills.map(({ filePath }) => filePath),
			extensionPaths: extensions.map(({ resolvedPath }) => resolvedPath),
		};
	}

	async createValidatedServices(
		agentId: string,
		inherited: InheritedRuntime,
	): Promise<AgentSessionServices> {
		const services = await createAgentSessionServices({
			cwd: inherited.baseline.cwd,
			agentDir: this.#ownerRuntime.services.agentDir,
			modelRuntime: this.#ownerRuntime.services.modelRuntime,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				additionalExtensionPaths: inherited.extensionPaths,
				additionalSkillPaths: inherited.skillPaths,
				extensionFactories: [
					{
						name: `pi-agent-coordination-agent:${agentId}`,
						hidden: true,
						factory: this.#childExtensionFactory(agentId),
					},
				],
			},
		});
		const extensions = services.resourceLoader.getExtensions();
		const skills = services.resourceLoader.getSkills();
		if (
			!services.modelRuntime.getModel(
				inherited.baseline.model.provider,
				inherited.baseline.model.modelId,
			)
		) {
			throw new Error("Inherited model is unavailable");
		}
		if (
			services.diagnostics.some(({ type }) => type === "error") ||
			extensions.errors.length > 0 ||
			skills.diagnostics.some(({ type }) => type === "error")
		) {
			throw new Error("Child resource validation failed");
		}
		const extensionTools = new Set(
			extensions.extensions.flatMap((extension) => [...extension.tools.keys()]),
		);
		for (const toolName of [...inherited.baseline.tools, ...ORDINARY_COORDINATION_TOOLS]) {
			if (!BUILT_IN_TOOL_NAMES.has(toolName) && !extensionTools.has(toolName)) {
				throw new Error(`Child tool resource is unavailable: ${toolName}`);
			}
		}
		const skillNames = skills.skills.map(({ name }) => name);
		if (!sameStringList(skillNames, inherited.baseline.skills)) {
			throw new Error("Child skill selection differs from its inherited baseline");
		}
		return services;
	}

	async startSession(options: {
		sessionManager: SessionManager;
		services: AgentSessionServices;
		inherited: InheritedRuntime;
		parentSession: AgentSession;
	}): Promise<AgentSession> {
		const { sessionManager, services, inherited, parentSession } = options;
		// The model is preflighted before Identity commit, but provider state can still
		// change before the child Run starts, so startup rechecks it at the live boundary.
		const model = services.modelRuntime.getModel(
			inherited.baseline.model.provider,
			inherited.baseline.model.modelId,
		);
		if (!model) throw new Error("Inherited model is unavailable");
		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent: { type: "session_start", reason: "startup" },
			model,
			thinkingLevel: inherited.baseline.thinking,
			tools: [...inherited.baseline.tools, ...ORDINARY_COORDINATION_TOOLS],
		});
		const session = created.session;
		try {
			this.#validateStartedSession(session, inherited);
			const bindings = copyExtensionBindings(parentSession, session);
			const parentErrorListener = bindings.onError;
			const startupErrors: string[] = [];
			bindings.onError = (error) => {
				startupErrors.push(error.error);
				parentErrorListener?.(error);
			};
			await session.bindExtensions(bindings);
			if (startupErrors.length > 0) {
				throw new Error(`Child extension startup failed: ${startupErrors[0]}`);
			}
			if (
				!session.getToolDefinition("agent_message") ||
				!session.getToolDefinition("agent_spawn") ||
				!session.getToolDefinition("agent_observe") ||
				!session.getToolDefinition("ask_user_question")
			) {
				throw new ProtocolInvariantError(
					"started child Run is missing ordinary coordination surfaces",
				);
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

	#validateStartedSession(session: AgentSession, inherited: InheritedRuntime): void {
		const activeTools = new Set(session.getActiveToolNames());
		for (const required of [...inherited.baseline.tools, ...ORDINARY_COORDINATION_TOOLS]) {
			if (!activeTools.has(required) || !session.getToolDefinition(required)) {
				throw new ProtocolInvariantError(
					`started child Run is missing required tool ${required}`,
				);
			}
		}
	}
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}
