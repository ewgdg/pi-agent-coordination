import { StdinBuffer } from "@earendil-works/pi-tui";

import { isTerminalInputSubmission } from "./terminal-input-submission-tracker.ts";

export type TerminalInputSubmissionAcknowledgmentBinding = Readonly<{
	handleInput(data: string | Buffer): void;
	dispose(): void;
}>;

/**
 * Keeps child acknowledgment identity continuous while /reload replaces the
 * extension generation that owns the physical-terminal listener.
 */
export class TerminalInputSubmissionAcknowledger {
	readonly #acknowledge: (sequence: number) => void;
	#latestSequence = 0;
	#currentGeneration = 0;

	constructor(acknowledge: (sequence: number) => void) {
		this.#acknowledge = acknowledge;
	}

	bind(): TerminalInputSubmissionAcknowledgmentBinding {
		const generation = ++this.#currentGeneration;
		const terminalInput = new StdinBuffer();
		let disposed = false;
		terminalInput.on("data", (data) => {
			if (disposed || generation !== this.#currentGeneration) return;
			if (isTerminalInputSubmission(data)) this.#acknowledge(++this.#latestSequence);
		});
		terminalInput.on("paste", () => undefined);
		return Object.freeze({
			handleInput: (data: string | Buffer) => {
				if (disposed || generation !== this.#currentGeneration) return;
				terminalInput.process(data);
			},
			dispose: () => {
				if (disposed) return;
				disposed = true;
				terminalInput.destroy();
				terminalInput.removeAllListeners();
			},
		});
	}
}
