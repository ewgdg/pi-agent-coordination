import type {
	ExtensionUIContext,
	Theme,
} from "@earendil-works/pi-coding-agent";

export type SelectedAgentPhase =
	| "dormant"
	| "starting"
	| "active"
	| "settled"
	| "held"
	| "waiting_human"
	| "ending"
	| "failed";

export type SelectedAgentStatus = Readonly<{
	label: string;
	sessionId: string;
	phase: SelectedAgentPhase;
}>;

export type SelectedAgentStatusPresentation = Readonly<{
	present(status: SelectedAgentStatus): void;
	clear(): void;
}>;

export const SELECTED_AGENT_STATUS_KEY = "agent-coordination-selected-agent";

// Keep the accepted footer identity compact while retaining enough context to distinguish sessions.
const COMPACT_SESSION_IDENTITY_LENGTH = 8;

export function formatSessionIdentity(sessionId: string): string {
	return sessionId.slice(-COMPACT_SESSION_IDENTITY_LENGTH);
}

export function formatAgentPhase(phase: SelectedAgentPhase): string {
	return phase === "dormant"
		? "Dormant"
		: phase === "waiting_human"
			? "waiting (human)"
			: phase;
}

export function formatSelectedAgentStatus(
	status: SelectedAgentStatus,
	theme: Theme,
): string {
	const phase = formatAgentPhase(status.phase);
	const identity = ` · ${formatSessionIdentity(status.sessionId)} · `;
	if (status.phase === "failed") {
		return theme.fg("error", `${status.label}${identity}${phase}`);
	}
	const marker = status.phase === "active" ? "● " : status.phase === "dormant" ? "○ " : "";
	const label = `${marker}${status.label}`;
	const emphasizedLabel = theme.fg("accent", theme.bold(label));
	if (status.phase === "waiting_human") {
		return `${emphasizedLabel}${theme.fg("dim", identity)}${theme.fg("warning", phase)}`;
	}
	return `${emphasizedLabel}${theme.fg("dim", `${identity}${phase}`)}`;
}

export class SelectedAgentStatusSurface implements SelectedAgentStatusPresentation {
	readonly #ui: Pick<ExtensionUIContext, "setStatus" | "theme">;

	constructor(ui: Pick<ExtensionUIContext, "setStatus" | "theme">) {
		this.#ui = ui;
	}

	present(status: SelectedAgentStatus): void {
		this.#ui.setStatus(
			SELECTED_AGENT_STATUS_KEY,
			formatSelectedAgentStatus(status, this.#ui.theme),
		);
	}

	clear(): void {
		this.#ui.setStatus(SELECTED_AGENT_STATUS_KEY, undefined);
	}
}
