import type { TUI } from "@earendil-works/pi-tui";

import type { TerminalProjection } from "./terminal-projection.ts";

const RESTORE_OWNER_TERMINAL = [
	"\x1b[?2026l",
	"\x1b[?1006l",
	"\x1b[?1004l",
	"\x1b[?1003l",
	"\x1b[?1002l",
	"\x1b[?1000l",
	"\x1b[?2004l",
	"\x1b[?2031l",
	"\x1b[<u",
	"\x1b[>4;0m",
	"\x1b]9;4;0\x07",
	"\x1b[?7h",
	"\x1b[?25h",
	"\x1b[?1049l",
	"\x1b[0m",
].join("");

/** Physical terminal operations isolated from Workflow and Runtime coordination. */
export type PhysicalTerminalPort = Readonly<{
	supportsPhysicalAttachment: boolean;
	columns(): number;
	rows(): number;
	write(data: string): boolean;
	waitForDrain(): Promise<void>;
	start(
		onInput: (data: string) => void,
		onResize: (columns: number, rows: number) => void,
	): void;
	stop(): void;
}>;

/**
 * Owns the one physical terminal lease shared by all process-backed Agent views.
 * Owner presentation and child PTYs remain deliberately asymmetric behind this
 * module: the Owner is suspended in place; a selected child receives raw routing.
 */
export class PhysicalTerminalAttachment {
	readonly #ownerTui: TUI;
	readonly #physicalTerminal: PhysicalTerminalPort;
	readonly #fail: (error: unknown) => void;
	readonly #requestExit: () => void;
	#desiredProjection: TerminalProjection | undefined;
	#projection: TerminalProjection | undefined;
	#outputRoutingActive = false;
	#inputReady = false;
	#inputBufferingActive = false;
	#outputDraining = false;
	#backpressuredProjection: TerminalProjection | undefined;
	#physicalOutputDrain = Promise.resolve();
	readonly #pendingInput: string[] = [];
	readonly #pendingOutput: string[] = [];
	readonly #outputFlushWaiters = new Set<() => void>();
	#removeOutputHandler: () => void = () => undefined;
	#removeFailureHandler: () => void = () => undefined;
	#removeExitHandler: () => void = () => undefined;
	#operationTail = Promise.resolve();
	#cancelPreparation: (() => Promise<void>) | undefined;
	readonly #releasingProjections = new Set<Promise<void>>();
	#ownerSuspended = false;
	#closed = false;
	#closePromise: Promise<void> | undefined;

	constructor(options: {
		ownerTui: TUI;
		physicalTerminal: PhysicalTerminalPort;
		fail(error: unknown): void;
		requestExit(): void;
	}) {
		this.#ownerTui = options.ownerTui;
		this.#physicalTerminal = options.physicalTerminal;
		this.#fail = options.fail;
		this.#requestExit = options.requestExit;
	}

	attach(projection: TerminalProjection): Promise<void> {
		if (this.#closed) return Promise.resolve();
		let cancelledPreparation = Promise.resolve();
		if (this.#desiredProjection !== projection) {
			this.#desiredProjection = projection;
			this.#inputReady = false;
			this.#inputBufferingActive = false;
			this.#pendingInput.length = 0;
			cancelledPreparation = this.#cancelPreparation?.() ?? Promise.resolve();
		}
		// The current child owns the visible loading selector until a complete
		// replacement frame exists. Disconnecting it here freezes that spinner.
		// Observe cancellation failure immediately, even while an earlier
		// preparation is still settling, without starting a concurrent handoff.
		const operation = Promise.allSettled([this.#operationTail, cancelledPreparation])
			.then(async ([, cancellation]) => {
				if (cancellation.status === "rejected") throw cancellation.reason;
				await this.#attach(projection);
			});
		this.#operationTail = operation.catch(() => undefined);
		return operation;
	}

	suspend(): Promise<void> {
		if (this.#closed) return Promise.resolve();
		this.#desiredProjection = undefined;
		this.#pendingInput.length = 0;
		this.#pendingOutput.length = 0;
		const errors: unknown[] = [];
		const cancelledPreparation = this.#cancelPreparation?.() ?? Promise.resolve();
		this.#releaseProjection();
		const releasedProjection = Promise.allSettled([cancelledPreparation, ...this.#releasingProjections]);
		this.#restoreOwner(errors);
		const operation = this.#operationTail.then(async () => {
			for (const release of await releasedProjection) {
				if (release.status === "rejected") errors.push(release.reason);
			}
			const combined = combinedError(errors);
			if (combined) throw combined;
		});
		this.#operationTail = operation.catch(() => undefined);
		return operation;
	}

	dispatchInput(data: string): void {
		if (this.#closed || !this.#desiredProjection) return;
		const projection = this.#projection;
		if (!projection || projection !== this.#desiredProjection) return;
		if (!this.#inputReady) {
			// Retargeting can leave terminal-query replies from the previous child in
			// physical stdin. Accept input only after the new native frame is complete.
			if (this.#inputBufferingActive) this.#pendingInput.push(data);
			return;
		}
		try {
			projection.dispatchInput(data);
		} catch (error) {
			this.#failAttachment(error);
		}
	}

	close(): Promise<void> {
		this.#closePromise ??= this.#close().catch((error) => this.#fail(error));
		return this.#closePromise;
	}

	async #close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#desiredProjection = undefined;
		this.#pendingInput.length = 0;
		this.#pendingOutput.length = 0;
		this.#settleOutputFlush();
		const errors: unknown[] = [];
		const cancelledPreparation = this.#cancelPreparation?.() ?? Promise.resolve();
		this.#releaseProjection();
		const releasedProjection = Promise.all([cancelledPreparation, ...this.#releasingProjections]);
		this.#restoreOwner(errors);
		await releasedProjection.catch((error) => errors.push(error));
		const combined = combinedError(errors);
		if (combined) throw combined;
	}

	#restoreOwner(errors: unknown[]): void {
		if (!this.#ownerSuspended) return;
		for (const restore of [
			() => this.#physicalTerminal.stop(),
			() => { this.#physicalTerminal.write(RESTORE_OWNER_TERMINAL); },
			() => this.#ownerTui.start(),
			() => this.#ownerTui.requestRender(true),
		]) {
			try {
				restore();
			} catch (error) {
				errors.push(error);
			}
		}
		this.#ownerSuspended = false;
	}

	async #attach(projection: TerminalProjection): Promise<void> {
		if (this.#closed || this.#desiredProjection !== projection) return;
		if (this.#projection === projection) {
			this.#inputReady = true;
			return;
		}
		const preparedOutput: string[] = [];
		let cancelled = false;
		let detachment: Promise<void> | undefined;
		let removeOutputHandler = () => {};
		let removeFailureHandler = () => {};
		let removeExitHandler = () => {};
		const cancelPreparation = () => {
			cancelled = true;
			removeOutputHandler();
			removeFailureHandler();
			removeExitHandler();
			detachment ??= projection.physicalTerminal.endAttachment();
			return detachment;
		};
		this.#cancelPreparation = cancelPreparation;
		try {
			removeFailureHandler = projection.addFailureHandler((error) => {
				if (!cancelled) this.#failAttachment(error);
			});
			if (cancelled) return;
			removeExitHandler = projection.addExitRequestHandler(() => {
				if (!cancelled && !this.#closed) void this.close().then(this.#requestExit);
			});
			if (cancelled) return;
			projection.resize(this.#physicalTerminal.columns(), this.#physicalTerminal.rows());
			removeOutputHandler = await projection.physicalTerminal.beginAttachment((data) => {
				if (cancelled || this.#closed) return;
				if (this.#projection !== projection) {
					preparedOutput.push(data);
					return;
				}
				this.#pendingOutput.push(data);
				if (this.#outputRoutingActive) this.#drainOutput(projection);
			});
			if (this.#outputDraining || this.#pendingOutput.length > 0) {
				await this.#waitForOutputFlush();
			}
			if (cancelled || this.#closed || this.#desiredProjection !== projection) return;

			// Rebuilding the previous detached terminal can be slow. Its physical
			// output is already drained; publish the replacement before awaiting it.
			const releasedProjection = this.#releaseProjection().then(
				() => undefined,
				(error: unknown) => ({ error }),
			);
			this.#projection = projection;
			this.#removeOutputHandler = removeOutputHandler;
			this.#removeFailureHandler = removeFailureHandler;
			this.#removeExitHandler = removeExitHandler;
			this.#cancelPreparation = undefined;
			this.#pendingOutput.push(...preparedOutput);
			this.#inputBufferingActive = true;
			if (!this.#ownerSuspended) this.#suspendOwner();
			this.#outputRoutingActive = true;
			this.#drainOutput(projection);
			await this.#waitForOutputFlush();
			if (!this.#closed && this.#desiredProjection === projection) {
				this.#inputReady = true;
				for (const data of this.#pendingInput.splice(0)) this.dispatchInput(data);
			}
			const releaseFailure = await releasedProjection;
			if (releaseFailure) throw releaseFailure.error;
		} finally {
			if (this.#cancelPreparation === cancelPreparation) {
				this.#cancelPreparation = undefined;
				await cancelPreparation();
			} else if (cancelled) {
				// Cancellation can precede asynchronous subscription setup completing.
				await cancelPreparation();
			}
		}
	}

	#suspendOwner(): void {
		this.#ownerTui.stop({ preserveScreen: true });
		this.#ownerSuspended = true;
		this.#physicalTerminal.start(
			(data) => this.dispatchInput(data),
			(columns, rows) => {
				if (this.#closed) return;
				try {
					// Both the visible selector and its pending replacement must fit
					// the terminal if it changes size during preparation.
					for (const projection of new Set([this.#projection, this.#desiredProjection])) {
						projection?.resize(columns, rows);
					}
				} catch (error) {
					this.#failAttachment(error);
				}
			},
		);
	}

	#releaseProjection(): Promise<void> {
		const projection = this.#projection;
		const errors: unknown[] = [];
		this.#projection = undefined;
		this.#outputRoutingActive = false;
		this.#inputReady = false;
		this.#inputBufferingActive = false;
		const resumeOutput = projection && this.#backpressuredProjection === projection;
		const pendingPhysicalDrain = resumeOutput
			? this.#physicalOutputDrain
			: Promise.resolve();
		if (resumeOutput) {
			this.#backpressuredProjection = undefined;
			this.#outputDraining = false;
			this.#physicalOutputDrain = Promise.resolve();
		}
		this.#removeOutputHandler();
		this.#removeFailureHandler();
		this.#removeExitHandler();
		this.#removeOutputHandler = () => undefined;
		this.#removeFailureHandler = () => undefined;
		this.#removeExitHandler = () => undefined;
		if (resumeOutput) {
			try {
				projection.physicalTerminal.resumeOutput();
			} catch (error) {
				errors.push(error);
			}
		}
		const detached = projection
			? projection.physicalTerminal.endAttachment()
			: Promise.resolve();
		this.#settleOutputFlush();
		const release = Promise.allSettled([pendingPhysicalDrain, detached]).then((results) => {
			for (const result of results) {
				if (result.status === "rejected") errors.push(result.reason);
			}
			const error = combinedError(errors);
			if (error) throw error;
		});
		this.#releasingProjections.add(release);
		void release.then(
			() => this.#releasingProjections.delete(release),
			() => this.#releasingProjections.delete(release),
		);
		return release;
	}

	#drainOutput(projection: TerminalProjection): void {
		if (
			this.#outputDraining
			|| this.#closed
			|| this.#projection !== projection
		) return;
		while (this.#pendingOutput.length > 0) {
			const data = this.#pendingOutput.shift()!;
			let accepted: boolean;
			try {
				accepted = this.#physicalTerminal.write(data);
			} catch (error) {
				this.#failAttachment(error);
				return;
			}
			if (accepted) continue;
			this.#outputDraining = true;
			this.#backpressuredProjection = projection;
			try {
				projection.physicalTerminal.pauseOutput();
			} catch (error) {
				this.#failAttachment(error);
				return;
			}
			const physicalOutputDrain = this.#physicalTerminal.waitForDrain();
			this.#physicalOutputDrain = physicalOutputDrain;
			void physicalOutputDrain.then(
				() => this.#resumeOutputAfterDrain(projection),
				(error) => {
					if (this.#projection === projection) this.#failAttachment(error);
				},
			);
			return;
		}
		this.#settleOutputFlush();
	}

	#resumeOutputAfterDrain(projection: TerminalProjection): void {
		if (this.#backpressuredProjection !== projection) return;
		this.#backpressuredProjection = undefined;
		this.#outputDraining = false;
		try {
			projection.physicalTerminal.resumeOutput();
		} catch (error) {
			if (this.#projection === projection) this.#failAttachment(error);
			return;
		}
		if (this.#projection === projection) this.#drainOutput(projection);
		else this.#settleOutputFlush();
	}

	#waitForOutputFlush(): Promise<void> {
		if (!this.#outputDraining && this.#pendingOutput.length === 0) {
			return Promise.resolve();
		}
		return new Promise((resolve) => this.#outputFlushWaiters.add(resolve));
	}

	#settleOutputFlush(): void {
		if (this.#outputDraining || this.#pendingOutput.length > 0) return;
		for (const resolve of this.#outputFlushWaiters) resolve();
		this.#outputFlushWaiters.clear();
	}

	#failAttachment(error: unknown): void {
		if (this.#closed) return;
		const closeOperation = this.#close();
		this.#closePromise = closeOperation.then(
			() => this.#fail(error),
			(restorationError) => this.#fail(new AggregateError(
				[error, restorationError],
				`physical_terminal_attachment_failed: ${errorMessage(error)}`,
			)),
		);
	}
}

function combinedError(errors: readonly unknown[]): unknown | undefined {
	if (errors.length === 0) return undefined;
	if (errors.length === 1) return errors[0];
	return new AggregateError(errors, "physical_terminal_restoration_failed");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createProcessPhysicalTerminalPort(
	ownerTui: TUI,
): PhysicalTerminalPort {
	let inputHandler: ((data: string | Buffer) => void) | undefined;
	let resizeHandler: (() => void) | undefined;
	let wasRaw = false;
	let started = false;
	const supportsPhysicalAttachment = Boolean(
		process.stdin.isTTY && process.stdout.isTTY && process.stdin.setRawMode,
	);
	let processTerminalActive = false;
	return {
		supportsPhysicalAttachment,
		columns: () => process.stdout.columns || ownerTui.terminal.columns,
		rows: () => process.stdout.rows || ownerTui.terminal.rows,
		write: (data) => {
			if (processTerminalActive) return process.stdout.write(data);
			ownerTui.terminal.write(data);
			return true;
		},
		waitForDrain() {
			if (!processTerminalActive || !process.stdout.writableNeedDrain) {
				return Promise.resolve();
			}
			return new Promise<void>((resolve, reject) => {
				const cleanup = () => {
					process.stdout.off("drain", onDrain);
					process.stdout.off("error", onError);
				};
				const onDrain = () => {
					cleanup();
					resolve();
				};
				const onError = (error: Error) => {
					cleanup();
					reject(error);
				};
				process.stdout.once("drain", onDrain);
				process.stdout.once("error", onError);
			});
		},
		start(onInput, onResize) {
			if (!supportsPhysicalAttachment) {
				throw new Error("physical_terminal_unavailable");
			}
			if (started) throw new Error("physical_terminal_already_attached");
			started = true;
			processTerminalActive = true;
			wasRaw = process.stdin.isRaw || false;
			inputHandler = (data) => onInput(
				typeof data === "string" ? data : data.toString("utf8"),
			);
			resizeHandler = () => onResize(
				process.stdout.columns || ownerTui.terminal.columns,
				process.stdout.rows || ownerTui.terminal.rows,
			);
			process.stdin.setRawMode(true);
			process.stdin.resume();
			process.stdin.on("data", inputHandler);
			process.stdout.on("resize", resizeHandler);
		},
		stop() {
			if (!started) return;
			started = false;
			if (!processTerminalActive) return;
			processTerminalActive = false;
			if (inputHandler) process.stdin.off("data", inputHandler);
			if (resizeHandler) process.stdout.off("resize", resizeHandler);
			inputHandler = undefined;
			resizeHandler = undefined;
			process.stdin.pause();
			process.stdin.setRawMode?.(wasRaw);
		},
	};
}
