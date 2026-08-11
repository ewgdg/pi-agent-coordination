import type { Component } from "@earendil-works/pi-tui";

/** Complete terminal-facing surface for one Agent Runtime. */
export type TerminalProjection = Readonly<{
	presentation: Component;
	resize(columns: number, rows: number): void;
	dispatchInput(data: string): void;
	focusEditor(): void;
	addChangeHandler(handler: () => void): () => void;
	addFailureHandler(handler: (error: unknown) => void): () => void;
	addExitRequestHandler(handler: () => void): () => void;
}>;
