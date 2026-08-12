import { getKeybindings, StdinBuffer } from "@earendil-works/pi-tui";

/**
 * Tracks submit keys from the same terminal stream shape Pi consumes. StdinBuffer
 * collapses bracketed paste into a paste event, so embedded CR/LF remain content.
 */
export class TerminalInputSubmissionTracker {
	readonly #terminalInput = new StdinBuffer();
	#latestSequence = 0;

	constructor() {
		this.#terminalInput.on("data", (data) => {
			if (isTerminalInputSubmission(data)) this.#latestSequence += 1;
		});
		this.#terminalInput.on("paste", () => undefined);
	}

	observe(data: string | Buffer): number {
		this.#terminalInput.process(data);
		return this.#latestSequence;
	}

	dispose(): void {
		this.#terminalInput.destroy();
		this.#terminalInput.removeAllListeners();
	}
}

export function isTerminalInputSubmission(data: string): boolean {
	return getKeybindings().matches(data, "tui.input.submit");
}
