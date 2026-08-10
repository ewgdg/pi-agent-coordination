import type {
	ExtensionUIContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";

import type {
	AgentRosterStatus,
} from "../coordination/workflow-coordinator.ts";
import type { LiveRunState } from "../runtime/in-process-agent-host.ts";
import type { HumanAttentionItem } from "../coordination/human-requests.ts";
import type { OperationalIncidentAttention } from "../coordination/operational-incidents.ts";
import {
	formatOperationalIncidentHeadline,
} from "./operational-incident-surface.ts";
import {
	formatAgentWorkStatus,
	formatSelectedAgentIdentity,
	selectedAgentWorkStatus,
	type AgentWorkStatus,
} from "./selected-agent-status.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_FRAME_INTERVAL_MS = 80;

export const AGENT_ACTIVITY_WIDGET_KEY = "agent-coordination-activity";

export type AgentActivityStatus = AgentRosterStatus & Readonly<{
	failed: boolean;
}>;

export type AgentActivitySnapshot = Readonly<{
	scope: AgentActivityStatus;
	children: readonly AgentActivityStatus[];
	humanAttention: readonly HumanAttentionItem[];
	operationalAttention: readonly OperationalIncidentAttention[];
}>;

export type AgentActivitySource = Readonly<{
	snapshot(): AgentActivitySnapshot;
	addChangeHandler(handler: () => void): () => void;
}>;

export function installAgentActivityDock(
	ui: Pick<ExtensionUIContext, "setWidget">,
	source: AgentActivitySource,
): void {
	ui.setWidget(
		AGENT_ACTIVITY_WIDGET_KEY,
		(tui, theme) => new AgentActivityDock(tui, theme, source),
		{ placement: "aboveEditor" },
	);
}

export class AgentActivityDock implements Component {
	readonly #tui: Pick<TUI, "requestRender">;
	readonly #theme: Theme;
	readonly #source: AgentActivitySource;
	readonly #removeChangeHandler: () => void;
	#spinnerTimer: ReturnType<typeof setInterval> | undefined;
	#disposed = false;

	constructor(
		tui: Pick<TUI, "requestRender">,
		theme: Theme,
		source: AgentActivitySource,
	) {
		this.#tui = tui;
		this.#theme = theme;
		this.#source = source;
		this.#removeChangeHandler = source.addChangeHandler(() => {
			this.#syncSpinner();
			this.#tui.requestRender();
		});
		this.#syncSpinner();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const snapshot = this.#source.snapshot();
		const ownerScope = snapshot.scope.agentId === snapshot.scope.workflowId;
		const identityLines = ownerScope
			? []
			: [formatSelectedAgentIdentity({
				label: snapshot.scope.label,
				agentId: snapshot.scope.agentId,
				status: selectedAgentWorkStatus(
					snapshot.scope.run,
					snapshot.scope.failed,
				),
			}, this.#theme)];
		const attentionLines = ownerScope
			? this.#renderAttention(
				snapshot.humanAttention,
				snapshot.operationalAttention,
			)
			: [];
		const liveChildren = snapshot.children.filter(hasLiveRun);
		const agentLines = liveChildren.length === 0
			? []
			: [
				this.#heading("Agents"),
				...liveChildren.map((child, index) =>
					this.#renderAgent(child, index, liveChildren.length)
				),
			];
		this.#syncSpinner(snapshot);
		return [...identityLines, ...attentionLines, ...agentLines].map(
			(line) => truncateToWidth(line, safeWidth, ""),
		);
	}

	invalidate(): void {}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#removeChangeHandler();
		this.#stopSpinner();
	}

	#renderAttention(
		human: readonly HumanAttentionItem[],
		operational: readonly OperationalIncidentAttention[],
	): string[] {
		const items = [
			...human.map((attention) => ({
				kind: "human" as const,
				attention,
			})),
			...operational.map((attention) => ({
				kind: "operational" as const,
				attention,
			})),
		];
		if (items.length === 0) return [];
		return [
			this.#heading("Attention Inbox"),
			...items.map((item, index) => {
				const branch = index === items.length - 1 ? "└─" : "├─";
				if (item.kind === "human") {
					const count = item.attention.questionCount;
					return `${branch} ${this.#theme.fg("warning", "DECIDE")} ${this.#theme.bold(item.attention.agentLabel)} · ${count} question${count === 1 ? "" : "s"}`;
				}
				return `${branch} ${this.#theme.fg("warning", "ATTENTION")} ${formatOperationalIncidentHeadline(item.attention)}`;
			}),
		];
	}

	#renderAgent(
		agent: LiveAgentActivityStatus,
		index: number,
		count: number,
	): string {
		const branch = index === count - 1 ? "└─" : "├─";
		const status = activityRowStatus(agent);
		const glyph = this.#activityGlyph(agent, status);
		const model = `${agent.model.provider}/${agent.model.modelId}:${agent.thinking}`;
		const queued = agent.queuedInputCount === 0
			? ""
			: ` · ${agent.queuedInputCount} queued`;
		return `${branch} ${glyph} ${this.#theme.bold(agent.label)} · ${model} · ${formatActivityRowStatus(status, this.#theme)}${queued}`;
	}

	#activityGlyph(agent: LiveAgentActivityStatus, status: AgentWorkStatus): string {
		if (status.kind === "active" || status.kind === "starting") {
			const frame = SPINNER_FRAMES[
				Math.floor(Date.now() / SPINNER_FRAME_INTERVAL_MS) % SPINNER_FRAMES.length
			]!;
			return this.#theme.fg("accent", frame);
		}
		if (status.kind === "waiting") return this.#theme.fg("warning", "■");
		if (status.kind === "failed") return this.#theme.fg("error", "×");
		return this.#theme.fg("dim", "○");
	}

	#heading(label: string): string {
		return this.#theme.fg("toolTitle", this.#theme.bold(label));
	}

	#syncSpinner(snapshot = this.#source.snapshot()): void {
		if (this.#disposed) return;
		const animated = snapshot.children.filter(hasLiveRun).some((child) => {
			const status = activityRowStatus(child);
			return status.kind === "active" || status.kind === "starting";
		});
		if (!animated) {
			this.#stopSpinner();
			return;
		}
		if (this.#spinnerTimer) return;
		this.#spinnerTimer = setInterval(
			() => this.#tui.requestRender(),
			SPINNER_FRAME_INTERVAL_MS,
		);
		this.#spinnerTimer.unref?.();
	}

	#stopSpinner(): void {
		if (!this.#spinnerTimer) return;
		clearInterval(this.#spinnerTimer);
		this.#spinnerTimer = undefined;
	}
}

type LiveAgentActivityStatus = Omit<AgentActivityStatus, "run"> & Readonly<{
	run: LiveRunState;
}>;

function hasLiveRun(agent: AgentActivityStatus): agent is LiveAgentActivityStatus {
	return agent.run.phase !== "dormant";
}

function activityRowStatus(agent: LiveAgentActivityStatus): AgentWorkStatus {
	return selectedAgentWorkStatus(agent.run, agent.failed);
}

function formatActivityRowStatus(status: AgentWorkStatus, theme: Theme): string {
	return formatAgentWorkStatus(status, theme);
}
