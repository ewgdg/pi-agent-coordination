import type { Component } from "@earendil-works/pi-tui";

/** Process-child operations needed only while it owns the physical terminal. */
export type PhysicalChildTerminal = Readonly<{
	addOutputHandler(handler: (data: string) => void): () => void;
	setAttached(attached: boolean): void;
	pauseOutput(): void;
	resumeOutput(): void;
	reinitializePresentation(): Promise<void>;
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
