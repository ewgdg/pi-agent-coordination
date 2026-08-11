import type { TerminalProjection } from "../presentation/terminal-projection.ts";

/** Runtime-host lifecycle operations kept behind the terminal-facing projection. */
export type HostedAgentProjection = TerminalProjection & Readonly<{
	isProcessingInput(): boolean;
	whenInputIdle(): Promise<void>;
	ready(): Promise<void>;
	cancelInitialization(error: unknown): Promise<void> | undefined;
	dispose(): Promise<void>;
}>;
