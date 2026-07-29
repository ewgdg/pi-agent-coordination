import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";

import { getAgentDefinition } from "./agent-definitions.ts";
import type { LiveSessionKey } from "./live-session-multiplexer.ts";
import { formatAgentPhase } from "./selected-agent-status.ts";
import type { InProcessSupervisorCoordinator } from "./supervisor-coordinator.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_FRAME_MS = 80;

export class AgentActivity implements Component {
	readonly #tui: TUI;
	readonly #theme: Theme;
	readonly #coordinator: InProcessSupervisorCoordinator;
	readonly #selectedKey: LiveSessionKey;
	readonly #requestRender: () => void;
	#spinnerTimer: ReturnType<typeof setInterval> | undefined;

	constructor(
		tui: TUI,
		theme: Theme,
		coordinator: InProcessSupervisorCoordinator,
		selectedKey: LiveSessionKey,
	) {
		this.#tui = tui;
		this.#theme = theme;
		this.#coordinator = coordinator;
		this.#selectedKey = selectedKey;
		this.#requestRender = () => {
			this.#syncSpinner();
			this.#tui.requestRender();
		};
		coordinator.on("change", this.#requestRender);
		this.#syncSpinner();
	}

	dispose(): void {
		this.#coordinator.off("change", this.#requestRender);
		this.#stopSpinner();
	}

	invalidate(): void {}

	render(width: number): string[] {
		this.#syncSpinner();
		const children = this.#coordinator.childrenOf(this.#selectedKey);
		const pendingRequests =
			this.#selectedKey === "owner" ? this.#coordinator.pendingHumanRequests() : [];
		if (children.length === 0 && pendingRequests.length === 0) return [];

		const attentionLines = pendingRequests.flatMap((request, index) => {
			const branch = index === pendingRequests.length - 1 ? "└─" : "├─";
			const definition = getAgentDefinition(request.agentKey);
			const row = `${branch} ${this.#theme.fg("warning", "DECIDE")} ${this.#theme.bold(definition.name)} · ${request.prompt}`;
			return index === 0
				? [this.#theme.fg("toolTitle", this.#theme.bold("Attention Inbox")), row]
				: [row];
		});
		const agentLines = children.map(({ definition, slot }, index) => {
			const branch = index === children.length - 1 ? "└─" : "├─";
			const phase = this.#coordinator.phaseOf(definition.key);
			const active = phase === "working";
			const spinner = active
				? SPINNER_FRAMES[Math.floor(Date.now() / SPINNER_FRAME_MS) % SPINNER_FRAMES.length]
				: phase === "waiting_human"
					? "■"
					: "○";
			const glyph = active
				? this.#theme.fg("accent", spinner)
				: phase === "waiting_human"
					? this.#theme.fg("warning", spinner)
					: spinner;
			const model = slot.session.model?.id ?? "no model";
			const thinking = slot.session.thinkingLevel;
			const phaseLabel = active
				? this.#theme.fg("accent", formatAgentPhase(phase))
				: phase === "waiting_human"
					? this.#theme.fg("warning", formatAgentPhase(phase))
					: formatAgentPhase(phase);
			const queued = slot.session.pendingMessageCount;
			const queueLabel = queued > 0 ? ` · ${queued} queued` : "";
			return truncateToWidth(
				`${branch} ${glyph} ${this.#theme.bold(definition.name)} · ${model}:${thinking} · ${phaseLabel}${queueLabel}`,
				width,
			);
		});
		return [
			...attentionLines,
			...(agentLines.length > 0
				? [this.#theme.fg("toolTitle", this.#theme.bold("Agents")), ...agentLines]
				: []),
		];
	}

	#syncSpinner(): void {
		const active = this.#coordinator
			.childrenOf(this.#selectedKey)
			.some(({ definition }) => this.#coordinator.phaseOf(definition.key) === "working");
		if (!active) {
			this.#stopSpinner();
			return;
		}
		if (this.#spinnerTimer) return;
		this.#spinnerTimer = setInterval(() => this.#tui.requestRender(), SPINNER_FRAME_MS);
		this.#spinnerTimer.unref?.();
	}

	#stopSpinner(): void {
		if (!this.#spinnerTimer) return;
		clearInterval(this.#spinnerTimer);
		this.#spinnerTimer = undefined;
	}
}
