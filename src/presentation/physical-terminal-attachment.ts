import type { TUI } from "@earendil-works/pi-tui";

import { addPrioritizedTuiInputListener } from "../pi-integration/prioritized-tui-input.ts";
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
	#outputDraining = false;
	#backpressuredProjection: TerminalProjection | undefined;
	readonly #pendingInput: string[] = [];
	readonly #pendingOutput: string[] = [];
	readonly #outputFlushWaiters = new Set<() => void>();
	#removeOwnerInputCapture: () => void = () => undefined;
	#removeOutputHandler: () => void = () => undefined;
	#removeFailureHandler: () => void = () => undefined;
	#removeExitHandler: () => void = () => undefined;
	#operationTail = Promise.resolve();
	#ownerSuspended = false;
	#closed = false;

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
		if (this.#desiredProjection !== projection) {
			this.#desiredProjection = projection;
			this.#outputRoutingActive = false;
			this.#inputReady = false;
			this.#pendingInput.length = 0;
			this.#pendingOutput.length = 0;
			if (this.#projection !== projection) {
				try {
					this.#releaseProjection();
				} catch (error) {
					return Promise.reject(error);
				}
			}
		}
		const operation = this.#operationTail.then(() => this.#attach(projection));
		this.#operationTail = operation.catch(() => undefined);
		return operation;
	}

	suspend(): Promise<void> {
		if (this.#closed) return Promise.resolve();
		this.#desiredProjection = undefined;
		this.#pendingInput.length = 0;
		this.#pendingOutput.length = 0;
		const operation = this.#operationTail.then(() => {
			const errors: unknown[] = [];
			try {
				this.#releaseProjection();
			} catch (error) {
				errors.push(error);
			}
			this.#restoreOwner(errors);
			const combined = combinedError(errors);
			if (combined) throw combined;
		});
		this.#operationTail = operation.catch(() => undefined);
		return operation;
	}

	dispatchInput(data: string): void {
		if (this.#closed || !this.#desiredProjection) return;
		const projection = this.#projection;
		if (
			!this.#inputReady
			|| !projection
			|| projection !== this.#desiredProjection
		) {
			this.#pendingInput.push(data);
			return;
		}
		try {
			projection.dispatchInput(data);
		} catch (error) {
			this.#failAttachment(error);
		}
	}

	close(): void {
		const restorationError = this.#close();
		if (restorationError) this.#fail(restorationError);
	}

	#close(): unknown | undefined {
		if (this.#closed) return;
		this.#closed = true;
		this.#desiredProjection = undefined;
		this.#pendingInput.length = 0;
		this.#pendingOutput.length = 0;
		this.#settleOutputFlush();
		const errors: unknown[] = [];
		try {
			this.#releaseProjection();
		} catch (error) {
			errors.push(error);
		}
		this.#restoreOwner(errors);
		return combinedError(errors);
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
		if (this.#projection === projection && this.#inputReady) return;
		if (this.#projection !== projection) this.#releaseProjection();
		if (this.#closed || this.#desiredProjection !== projection) return;
		this.#projection = projection;
		projection.physicalTerminal.setAttached(true);
		this.#removeOutputHandler = projection.physicalTerminal.addOutputHandler((data) => {
			if (this.#projection !== projection || this.#closed) return;
			// A partial restart can leave terminal modes and editor focus inconsistent.
			// Publish one ordered handoff only after the child's native TUI has restarted.
			this.#pendingOutput.push(data);
			if (this.#outputRoutingActive) this.#drainOutput(projection);
		});
		this.#removeFailureHandler = projection.addFailureHandler((error) => {
			if (this.#projection === projection) this.#failAttachment(error);
		});
		this.#removeExitHandler = projection.addExitRequestHandler(() => {
			if (this.#projection !== projection || this.#closed) return;
			this.close();
			this.#requestExit();
		});
		projection.resize(
			this.#physicalTerminal.columns(),
			this.#physicalTerminal.rows(),
		);
		if (!this.#ownerSuspended) this.#captureOwnerInput();
		await projection.physicalTerminal.reinitializePresentation();
		if (this.#closed || this.#desiredProjection !== projection) return;
		if (!this.#ownerSuspended) this.#suspendOwner();
		this.#outputRoutingActive = true;
		this.#drainOutput(projection);
		await this.#waitForOutputFlush();
		if (this.#closed || this.#desiredProjection !== projection) return;
		this.#inputReady = true;
		for (const data of this.#pendingInput.splice(0)) this.dispatchInput(data);
	}

	#captureOwnerInput(): void {
		this.#removeOwnerInputCapture = addPrioritizedTuiInputListener(
			this.#ownerTui,
			(data) => {
				this.dispatchInput(data);
				return { consume: true };
			},
		);
	}

	#suspendOwner(): void {
		this.#removeOwnerInputCapture();
		this.#removeOwnerInputCapture = () => undefined;
		this.#ownerTui.stop({ preserveScreen: true });
		this.#ownerSuspended = true;
		this.#physicalTerminal.start(
			(data) => this.dispatchInput(data),
			(columns, rows) => {
				const projection = this.#projection;
				if (!projection || this.#closed) return;
				try {
					projection.resize(columns, rows);
				} catch (error) {
					this.#failAttachment(error);
				}
			},
		);
	}

	#releaseProjection(): void {
		const projection = this.#projection;
		const errors: unknown[] = [];
		this.#projection = undefined;
		this.#outputRoutingActive = false;
		this.#inputReady = false;
		const resumeOutput = projection && this.#backpressuredProjection === projection;
		if (resumeOutput) {
			this.#backpressuredProjection = undefined;
			this.#outputDraining = false;
		}
		this.#removeOwnerInputCapture();
		this.#removeOwnerInputCapture = () => undefined;
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
		if (projection) {
			try {
				projection.physicalTerminal.setAttached(false);
			} catch (error) {
				errors.push(error);
			}
		}
		this.#settleOutputFlush();
		const error = combinedError(errors);
		if (error) throw error;
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
			void this.#physicalTerminal.waitForDrain().then(
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
		const restorationError = this.#close();
		this.#fail(restorationError
			? new AggregateError(
				[error, restorationError],
				`physical_terminal_attachment_failed: ${errorMessage(error)}`,
			)
			: error);
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
