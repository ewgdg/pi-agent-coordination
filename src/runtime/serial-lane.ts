export class SerialLane {
	#tail: Promise<void> = Promise.resolve();

	run<T>(operation: () => Promise<T> | T): Promise<T> {
		const result = this.#tail.then(operation, operation);
		this.#tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	idle(): Promise<void> {
		return this.#tail;
	}
}
