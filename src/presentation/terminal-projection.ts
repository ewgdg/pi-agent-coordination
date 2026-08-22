import type { Component } from "@earendil-works/pi-tui";

/** Process-child operations needed only while it owns the physical terminal. */
export type PhysicalChildTerminal = Readonly<{
	beginAttachment(handler: (data: string) => void): Promise<() => void>;
	endAttachment(): Promise<void>;
	pauseOutput(): void;
	resumeOutput(): void;
}>;

/** Complete terminal-facing surface for one Agent Runtime. */
export type TerminalProjection = Readonly<{
	presentation: Component;
	physicalTerminal: PhysicalChildTerminal;
	resize(columns: number, rows: number): void;
	dispatchInput(data: string): void;
	focusEditor(): void;
	addChangeHandler(handler: () => void): () => void;
	addFailureHandler(handler: (error: unknown) => void): () => void;
	addExitRequestHandler(handler: () => void): () => void;
}>;
