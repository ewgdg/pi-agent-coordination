import type { Theme } from "@earendil-works/pi-coding-agent";

export type SelectedAgentPhase = "idle" | "working" | "waiting_human" | "failed";

export type SelectedAgentStatus = {
	name: string;
	sessionId: string;
	phase: SelectedAgentPhase;
};

const SESSION_IDENTITY_LENGTH = 8;

export function formatSessionIdentity(sessionId: string): string {
	return sessionId.slice(-SESSION_IDENTITY_LENGTH);
}

export function formatAgentPhase(phase: SelectedAgentPhase): string {
	return phase === "waiting_human" ? "waiting (human)" : phase;
}

export function formatSelectedAgentStatus(status: SelectedAgentStatus, theme: Theme): string {
	const identity = formatSessionIdentity(status.sessionId);
	const prefix = `${status.name} · ${identity} · `;
	if (status.phase === "waiting_human") {
		return `${theme.fg("dim", prefix)}${theme.fg("warning", formatAgentPhase(status.phase))}`;
	}
	const color = status.phase === "failed" ? "error" : "dim";
	return theme.fg(color, `${prefix}${formatAgentPhase(status.phase)}`);
}
