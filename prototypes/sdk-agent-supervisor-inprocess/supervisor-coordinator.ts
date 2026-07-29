import { EventEmitter } from "node:events";
import { resolve } from "node:path";

import type {
	AgentSessionRuntime,
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

import {
	AGENT_DEFINITIONS,
	getAgentDefinition,
	getChildAgentDefinitions,
} from "./agent-definitions.ts";
import { AgentActivity } from "./agent-activity.ts";
import {
	openAgentSelectorOverlay,
	type AgentSelectorItem,
} from "./agent-selector-overlay.ts";
import {
	HumanRequestBridge,
	type PendingHumanRequest,
} from "./human-request-bridge.ts";
import {
	LiveSessionMultiplexer,
	type LiveSessionKey,
	type LiveSessionSlot,
} from "./live-session-multiplexer.ts";
import {
	bindPiRuntimeSelection,
	bindPiRuntimeShutdown,
} from "./pi-runtime-selection.ts";
import { getHostPiSdk } from "./runtime-capture.ts";
import {
	formatAgentPhase,
	formatSessionIdentity,
	formatSelectedAgentStatus,
} from "./selected-agent-status.ts";

const ACTIVITY_WIDGET_KEY = "sdk-agent-supervisor-inprocess-activity";
const STATUS_KEY = "sdk-agent-supervisor-inprocess";
const PROJECT_BOOTSTRAP_PATH = ".pi/extensions/sdk-agent-supervisor-inprocess.ts";

type ChildExtensionFactory = (key: LiveSessionKey) => ExtensionFactory;

export class InProcessSupervisorCoordinator extends EventEmitter {
	readonly #multiplexer: LiveSessionMultiplexer;
	readonly #slots = new Map<LiveSessionKey, LiveSessionSlot>();
	readonly #humanRequests: HumanRequestBridge;
	#activeContext: ExtensionContext | undefined;
	#activeContextKey: LiveSessionKey = "owner";

	private constructor(runtime: AgentSessionRuntime, ownerSlot: LiveSessionSlot) {
		super();
		this.#multiplexer = new LiveSessionMultiplexer(bindPiRuntimeSelection(runtime), ownerSlot);
		this.#slots.set(ownerSlot.key, ownerSlot);
		this.#humanRequests = new HumanRequestBridge((key) => this.#requireSlot(key).session);
		this.#humanRequests.on("change", () => {
			this.emit("change");
			this.#refreshUI();
		});
		bindPiRuntimeShutdown(runtime, this.#multiplexer);
		this.#observe(ownerSlot);
	}

	static async create(
		runtime: AgentSessionRuntime,
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		childExtensionFactory: ChildExtensionFactory,
	): Promise<InProcessSupervisorCoordinator> {
		const coordinator = new InProcessSupervisorCoordinator(runtime, {
			key: "owner",
			session: runtime.session,
			services: runtime.services,
			diagnostics: [...runtime.diagnostics],
			modelFallbackMessage: runtime.modelFallbackMessage,
		});

		// Every fixed-roster descendant gets a retained session up front; parentKey
		// controls ownership in the UI, not the lifetime of its process-local session.
		for (const definition of AGENT_DEFINITIONS.filter(({ key }) => key !== "owner")) {
			const slot = await coordinator.#createChildSlot(
				definition.key,
				pi,
				ctx,
				childExtensionFactory,
				runtime,
			);
			coordinator.#slots.set(slot.key, slot);
			coordinator.#multiplexer.register(slot);
			coordinator.#observe(slot);
		}

		return coordinator;
	}

	get selectedKey(): LiveSessionKey {
		return this.#multiplexer.selectedKey;
	}

	phaseOf(key: LiveSessionKey): "idle" | "working" | "waiting_human" {
		if (this.#humanRequests.pendingFor(key)) return "waiting_human";
		return this.#requireSlot(key).session.isStreaming ? "working" : "idle";
	}

	pendingHumanRequest(key: LiveSessionKey): PendingHumanRequest | undefined {
		return this.#humanRequests.pendingFor(key);
	}

	pendingHumanRequests(): PendingHumanRequest[] {
		return this.#humanRequests.allPending();
	}

	requestHumanAnswer(key: LiveSessionKey, prompt: string): Promise<string> {
		if (key === "owner") throw new Error("Owner cannot request a Human Answer from itself");
		return this.#humanRequests.request(key, prompt);
	}

	answerHumanRequest(key: LiveSessionKey, answer: string): boolean {
		return this.#humanRequests.answer(key, answer);
	}

	childrenOf(parentKey: LiveSessionKey): Array<{
		definition: ReturnType<typeof getAgentDefinition>;
		slot: LiveSessionSlot;
	}> {
		return getChildAgentDefinitions(parentKey).map(
			(definition) => ({
				definition,
				slot: this.#requireSlot(definition.key),
			}),
		);
	}

	mountSessionUI(key: LiveSessionKey, ctx: ExtensionContext): void {
		this.#activeContext = ctx;
		this.#activeContextKey = key;
		this.#refreshUI();
	}

	async openAgentSelector(ctx: ExtensionContext): Promise<void> {
		const attentionOptions: AgentSelectorItem[] = this.pendingHumanRequests().map((request) => {
			const definition = getAgentDefinition(request.agentKey);
			return {
				kind: "attention",
				value: definition.key,
				label: `${ctx.ui.theme.fg("warning", "DECIDE")} · ${definition.name}`,
				description: request.prompt,
				detailLines: this.#selectorDetailLines(definition.key),
			};
		});
		const agentOptions: AgentSelectorItem[] = AGENT_DEFINITIONS.map((definition) => {
			const phase = this.phaseOf(definition.key);
			const selected = definition.key === this.selectedKey ? " · selected" : "";
			return {
				kind: "agent",
				value: definition.key,
				label: definition.name,
				description: `${formatAgentPhase(phase)}${selected}`,
				parentValue: definition.parentKey,
				detailLines: this.#selectorDetailLines(definition.key),
			};
		});
		const options = [...attentionOptions, ...agentOptions];
		const selectedKey = await openAgentSelectorOverlay(ctx.ui, options, this.selectedKey);
		if (!selectedKey) return;
		const definition = AGENT_DEFINITIONS.find(({ key }) => key === selectedKey);
		if (!definition) throw new Error(`Unknown Agent selection: ${selectedKey}`);
		await this.#multiplexer.select(definition.key);
		this.mountSessionUI(definition.key, ctx);
	}

	#selectorDetailLines(key: LiveSessionKey): readonly [string, string] {
		const definition = getAgentDefinition(key);
		const session = this.#requireSlot(key).session;
		const model = session.model;
		const modelLabel = model ? `${model.provider}/${model.id}` : "no model";
		return [
			`${formatSessionIdentity(session.sessionManager.getSessionId())} · ${definition.description}`,
			`${modelLabel} · thinking ${session.thinkingLevel} · ${session.pendingMessageCount} queued`,
		];
	}

	async #createChildSlot(
		key: LiveSessionKey,
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		childExtensionFactory: ChildExtensionFactory,
		ownerRuntime: AgentSessionRuntime,
	): Promise<LiveSessionSlot> {
		if (!ctx.model) throw new Error("Owner has no model selected");
		const hostPi = getHostPiSdk();
		const projectBootstrapPath = resolve(ctx.cwd, PROJECT_BOOTSTRAP_PATH);
		const services = await hostPi.createAgentSessionServices({
			cwd: ctx.cwd,
			agentDir: ownerRuntime.services.agentDir,
			resourceLoaderOptions: {
				extensionsOverride: (base) => ({
					...base,
					extensions: base.extensions.filter(
						(extension) => extension.resolvedPath !== projectBootstrapPath,
					),
				}),
				extensionFactories: [
					{
						name: `sdk-agent-supervisor-${key}`,
						hidden: true,
						factory: childExtensionFactory(key),
					},
				],
			},
			resourceLoaderReloadOptions: {
				resolveProjectTrust: async () => ctx.isProjectTrusted(),
			},
		});
		const model = services.modelRuntime.getModel(ctx.model.provider, ctx.model.id);
		if (!model) {
			throw new Error(`Child cannot resolve Owner model ${ctx.model.provider}/${ctx.model.id}`);
		}
		const created = await hostPi.createAgentSessionFromServices({
			services,
			sessionManager: hostPi.SessionManager.inMemory(ctx.cwd),
			sessionStartEvent: { type: "session_start", reason: "startup" },
			model,
			thinkingLevel: pi.getThinkingLevel(),
			tools: pi.getActiveTools(),
		});
		return {
			key,
			session: created.session,
			services,
			diagnostics: services.diagnostics,
			modelFallbackMessage: created.modelFallbackMessage,
		};
	}

	#observe(slot: LiveSessionSlot): void {
		slot.session.subscribe(() => {
			this.emit("change");
			this.#refreshUI();
		});
	}

	#requireSlot(key: LiveSessionKey): LiveSessionSlot {
		const slot = this.#slots.get(key);
		if (!slot) throw new Error(`Agent session is not ready: ${key}`);
		return slot;
	}

	#refreshUI(): void {
		const ctx = this.#activeContext;
		if (!ctx) return;
		const key = this.#activeContextKey;
		const definition = getAgentDefinition(key);
		const slot = this.#requireSlot(key);
		ctx.ui.setWidget(ACTIVITY_WIDGET_KEY, undefined);
		if (this.childrenOf(key).length > 0) {
			ctx.ui.setWidget(
				ACTIVITY_WIDGET_KEY,
				(tui, theme) => new AgentActivity(tui, theme, this, key),
				{ placement: "aboveEditor" },
			);
		}
		if (key === "owner") {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const phase = this.phaseOf(key);
		ctx.ui.setStatus(
			STATUS_KEY,
			formatSelectedAgentStatus(
				{
					name: definition.name,
					sessionId: slot.session.sessionManager.getSessionId(),
					phase,
				},
				ctx.ui.theme,
			),
		);
	}
}
