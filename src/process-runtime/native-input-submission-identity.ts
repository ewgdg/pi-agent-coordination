export class NativeInputSubmissionIdentity {
	#latestTerminalSequence = 0;
	#currentInputSequence: number | undefined;

	observeTerminalSubmission(sequence: number): void {
		if (sequence <= this.#latestTerminalSequence) {
			throw new Error("native_input_sequence_not_monotonic");
		}
		this.#latestTerminalSequence = sequence;
	}

	beginInput(): number {
		if (this.#currentInputSequence !== undefined) return this.#currentInputSequence;
		if (this.#latestTerminalSequence < 1) {
			throw new Error("child_runtime_input_identity_unavailable");
		}
		this.#currentInputSequence = this.#latestTerminalSequence;
		return this.#currentInputSequence;
	}

	current(): number | undefined {
		return this.#currentInputSequence;
	}

	take(): number | undefined {
		const sequence = this.#currentInputSequence;
		this.#currentInputSequence = undefined;
		return sequence;
	}

	complete(sequence: number): boolean {
		if (this.#currentInputSequence !== sequence) return false;
		this.#currentInputSequence = undefined;
		return true;
	}
}
