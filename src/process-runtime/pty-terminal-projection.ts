import { Unicode11Addon } from "@xterm/addon-unicode11";
import xtermHeadless from "@xterm/headless";
import * as nodePty from "node-pty";

const { Terminal } = xtermHeadless;
const GENERATED_REPLY_QUIET_MS = 10;

export type TerminalCellColor =
	| Readonly<{ kind: "default" }>
	| Readonly<{ kind: "indexed"; index: number }>
	| Readonly<{ kind: "rgb"; red: number; green: number; blue: number }>;

export type TerminalCellStyle = Readonly<{
	foreground: TerminalCellColor;
	background: TerminalCellColor;
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
	blink: boolean;
	inverse: boolean;
	invisible: boolean;
	strikethrough: boolean;
	overline: boolean;
}>;

export type TerminalProjectionCell = Readonly<{
	text: string;
	width: number;
	style: TerminalCellStyle;
}>;

export type TerminalProjectionLine = Readonly<{
	text: string;
	wrapped: boolean;
	cells: readonly TerminalProjectionCell[];
}>;

export type TerminalCursorStyle = "block" | "underline" | "bar";

export type TerminalProjectionFrame = Readonly<{
	columns: number;
	rows: number;
	buffer: "normal" | "alternate";
	cursor: Readonly<{
		column: number;
		row: number;
		visible: boolean;
		style: TerminalCursorStyle;
		blink: boolean;
	}>;
	lines: readonly TerminalProjectionLine[];
}>;

export type PtyExit = Readonly<{ exitCode: number; signal: number }>;

export type SpawnPtyTerminalProjectionOptions = Readonly<{
	file: string;
	arguments?: readonly string[];
	cwd?: string;
	environment?: NodeJS.ProcessEnv;
	columns: number;
	rows: number;
	terminalName?: string;
}>;

export interface PtyTerminalProjection {
	readonly pid: number;
	readonly disposed: boolean;
	readonly exited: Promise<PtyExit>;
	frame(): TerminalProjectionFrame;
	addChangeHandler(handler: () => void): () => void;
	addFailureHandler(handler: (error: unknown) => void): () => void;
	addOutputHandler(handler: (data: string) => void): () => void;
	setPhysicalTerminalAttached(attached: boolean): void;
	pauseOutput(): void;
	resumeOutput(): void;
	writeInput(data: string | Buffer): void;
	resize(columns: number, rows: number): void;
	kill(signal: NodeJS.Signals): void;
	killProcessGroup(signal: NodeJS.Signals): void;
	drain(): Promise<void>;
	dispose(): Promise<void>;
}

export function spawnPtyTerminalProjection(
	options: SpawnPtyTerminalProjectionOptions,
): PtyTerminalProjection {
	requireDimension("columns", options.columns);
	requireDimension("rows", options.rows);
	const terminal = new Terminal({
		cols: options.columns,
		rows: options.rows,
		allowProposedApi: true,
	});
	terminal.loadAddon(new Unicode11Addon());
	terminal.unicode.activeVersion = "11";
	let child: nodePty.IPty;
	try {
		child = nodePty.spawn(options.file, [...(options.arguments ?? [])], {
			cwd: options.cwd,
			env: options.environment,
			cols: options.columns,
			rows: options.rows,
			name: options.terminalName ?? "xterm-256color",
		});
	} catch (error) {
		terminal.dispose();
		throw error;
	}
	return new NodePtyTerminalProjection(child, terminal);
}

class NodePtyTerminalProjection implements PtyTerminalProjection {
	readonly #child: nodePty.IPty;
	readonly #terminal: InstanceType<typeof Terminal>;
	readonly #subscriptions: Array<{ dispose(): void }> = [];
	readonly #drainWaiters = new Set<() => void>();
	readonly #changeHandlers = new Set<() => void>();
	readonly #failureHandlers = new Set<(error: unknown) => void>();
	readonly #outputHandlers = new Set<(data: string) => void>();
	#physicalTerminalAttached = false;
	#cursorVisible = true;
	#cursorStyle: TerminalCursorStyle = "block";
	#cursorBlink = false;
	#failure: Readonly<{ error: unknown }> | undefined;
	#pendingWrites = 0;
	#pendingGeneratedReplies: Buffer[] = [];
	#generatedReplyFlush: ReturnType<typeof setTimeout> | undefined;
	#exitObserved = false;
	#disposing = false;
	#disposed = false;
	#disposePromise: Promise<void> | undefined;
	readonly exited: Promise<PtyExit>;

	constructor(
		child: nodePty.IPty,
		terminal: InstanceType<typeof Terminal>,
	) {
		this.#child = child;
		this.#terminal = terminal;
		this.#subscriptions.push(
			child.onData((data) => this.#parseOutput(data)),
			terminal.onData((data) => this.#writeGeneratedReply(data)),
			terminal.onBinary((data) =>
				this.#writeGeneratedReply(Buffer.from(data, "binary")),
			),
			terminal.parser.registerCsiHandler(
				{ prefix: "?", final: "h" },
				(params) => this.#observeCursorVisibility(params, true),
			),
			terminal.parser.registerCsiHandler(
				{ prefix: "?", final: "l" },
				(params) => this.#observeCursorVisibility(params, false),
			),
			terminal.parser.registerCsiHandler(
				{ intermediates: " ", final: "q" },
				(params) => this.#observeCursorStyle(params),
			),
			terminal.parser.registerEscHandler(
				{ final: "c" },
				() => this.#observeTerminalReset(),
			),
		);
		this.exited = new Promise<PtyExit>((resolve) => {
			this.#subscriptions.push(
				child.onExit((event) => {
					this.#exitObserved = true;
					this.#discardGeneratedReplies();
					void this.#finishExit(event, resolve);
				}),
			);
		});
	}

	get pid(): number {
		return this.#child.pid;
	}

	get disposed(): boolean {
		return this.#disposed;
	}

	frame(): TerminalProjectionFrame {
		this.#requireActive();
		const buffer = this.#terminal.buffer.active;
		const lines = Array.from({ length: this.#terminal.rows }, (_, viewportRow) => {
			const line = buffer.getLine(buffer.viewportY + viewportRow);
			if (!line) return { text: "", wrapped: false, cells: [] };
			const cells = Array.from({ length: this.#terminal.cols }, (_, column) => {
				const cell = line.getCell(column);
				if (!cell) return emptyCell();
				return {
					text: cell.getChars(),
					width: cell.getWidth(),
					style: readCellStyle(cell),
				};
			});
			return {
				text: line.translateToString(true),
				wrapped: line.isWrapped,
				cells,
			};
		});
		return {
			columns: this.#terminal.cols,
			rows: this.#terminal.rows,
			buffer: buffer.type,
			cursor: {
				column: buffer.cursorX,
				row: buffer.baseY + buffer.cursorY - buffer.viewportY,
				visible: this.#cursorVisible,
				style: this.#cursorStyle,
				blink: this.#cursorBlink,
			},
			lines,
		};
	}

	addChangeHandler(handler: () => void): () => void {
		if (this.#disposed) return () => undefined;
		this.#changeHandlers.add(handler);
		return () => this.#changeHandlers.delete(handler);
	}

	addFailureHandler(handler: (error: unknown) => void): () => void {
		if (this.#disposed) return () => undefined;
		this.#failureHandlers.add(handler);
		if (this.#failure !== undefined) handler(this.#failure.error);
		return () => this.#failureHandlers.delete(handler);
	}

	addOutputHandler(handler: (data: string) => void): () => void {
		if (this.#disposed) return () => undefined;
		this.#outputHandlers.add(handler);
		return () => this.#outputHandlers.delete(handler);
	}

	setPhysicalTerminalAttached(attached: boolean): void {
		this.#requireActive();
		this.#physicalTerminalAttached = attached;
		if (attached) this.#discardGeneratedReplies();
	}

	pauseOutput(): void {
		this.#requireActive();
		this.#child.pause();
	}

	resumeOutput(): void {
		this.#requireActive();
		this.#child.resume();
	}

	writeInput(data: string | Buffer): void {
		this.#requireWritable();
		try {
			this.#child.write(data);
		} catch (error) {
			this.#notifyFailure(error);
			throw error;
		}
	}

	resize(columns: number, rows: number): void {
		this.#requireWritable();
		requireDimension("columns", columns);
		requireDimension("rows", rows);
		if (columns === this.#terminal.cols && rows === this.#terminal.rows) return;
		try {
			// The child can emit output synchronously in response to SIGWINCH, so the
			// emulator must expose the new geometry before the PTY is notified.
			this.#terminal.resize(columns, rows);
			this.#child.resize(columns, rows);
			this.#notifyChange();
		} catch (error) {
			this.#notifyFailure(error);
			throw error;
		}
	}

	kill(signal: NodeJS.Signals): void {
		this.#requireActive();
		if (this.#exitObserved) return;
		signalPty(this.#child, signal);
	}

	killProcessGroup(signal: NodeJS.Signals): void {
		this.#requireActive();
		signalOwnedPty(this.#child, signal);
	}

	drain(): Promise<void> {
		this.#requireActive();
		return this.#waitForParserDrain();
	}

	dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		this.#disposing = true;
		this.#discardGeneratedReplies();
		this.#disposePromise = this.#dispose();
		return this.#disposePromise;
	}

	#parseOutput(data: string): void {
		if (this.#disposed) return;
		for (const handler of this.#outputHandlers) {
			try {
				handler(data);
			} catch (error) {
				this.#notifyFailure(error);
			}
		}
		this.#pendingWrites += 1;
		try {
			this.#terminal.write(data, () => {
				this.#settleParsedWrite();
				this.#notifyChange();
			});
		} catch (error) {
			this.#settleParsedWrite();
			this.#notifyFailure(error);
		}
	}

	#writeGeneratedReply(data: string | Buffer): void {
		if (
			this.#disposed ||
			this.#disposing ||
			this.#exitObserved ||
			this.#physicalTerminalAttached
		) return;
		this.#pendingGeneratedReplies.push(Buffer.from(data));
		if (this.#generatedReplyFlush) clearTimeout(this.#generatedReplyFlush);
		// A short quiet period coalesces parser reply bursts and lets an exiting
		// child publish onExit before node-pty writes to its closing descriptor.
		this.#generatedReplyFlush = setTimeout(
			() => this.#flushGeneratedReplies(),
			GENERATED_REPLY_QUIET_MS,
		);
	}

	#flushGeneratedReplies(): void {
		this.#generatedReplyFlush = undefined;
		if (
			this.#disposed ||
			this.#disposing ||
			this.#exitObserved ||
			this.#physicalTerminalAttached
		) {
			this.#pendingGeneratedReplies = [];
			return;
		}
		const reply = Buffer.concat(this.#pendingGeneratedReplies);
		this.#pendingGeneratedReplies = [];
		try {
			this.#child.write(reply);
		} catch (error) {
			this.#notifyFailure(error);
		}
	}

	#discardGeneratedReplies(): void {
		if (this.#generatedReplyFlush) clearTimeout(this.#generatedReplyFlush);
		this.#generatedReplyFlush = undefined;
		this.#pendingGeneratedReplies = [];
	}

	#settleParsedWrite(): void {
		this.#pendingWrites -= 1;
		if (this.#pendingWrites !== 0) return;
		for (const resolve of this.#drainWaiters) resolve();
		this.#drainWaiters.clear();
	}

	#observeCursorVisibility(params: (number | number[])[], visible: boolean): false {
		if (params.some((parameter) => parameter === 25)) this.#cursorVisible = visible;
		return false;
	}

	#observeCursorStyle(params: (number | number[])[]): false {
		const parameter = typeof params[0] === "number" ? params[0] : 0;
		if (parameter === 0) {
			this.#cursorStyle = "block";
			this.#cursorBlink = true;
			return false;
		}
		if (parameter >= 1 && parameter <= 6) {
			this.#cursorStyle = parameter <= 2
				? "block"
				: parameter <= 4 ? "underline" : "bar";
			this.#cursorBlink = parameter % 2 === 1;
		}
		return false;
	}

	#observeTerminalReset(): false {
		this.#cursorVisible = true;
		this.#cursorStyle = "block";
		this.#cursorBlink = false;
		return false;
	}

	#notifyChange(): void {
		if (this.#disposed) return;
		for (const handler of this.#changeHandlers) handler();
	}

	#notifyFailure(error: unknown): void {
		if (this.#disposed) return;
		this.#failure ??= { error };
		for (const handler of this.#failureHandlers) handler(error);
	}

	async #finishExit(
		event: { exitCode: number; signal?: number },
		resolve: (exit: PtyExit) => void,
	): Promise<void> {
		await this.#waitForParserDrain();
		resolve({ exitCode: event.exitCode, signal: event.signal ?? 0 });
	}

	#waitForParserDrain(): Promise<void> {
		if (this.#pendingWrites === 0) return Promise.resolve();
		return new Promise((resolve) => this.#drainWaiters.add(resolve));
	}

	async #dispose(): Promise<void> {
		try {
			if (!this.#exitObserved) signalOwnedPty(this.#child, "SIGHUP");
			await this.exited;
			await this.#waitForParserDrain();
		} finally {
			let processGroupCleanupError: unknown;
			try {
				// Unix may retain signal-ignoring process-group descendants after the leader
				// exits. On Windows, node-pty's signal-less kill also releases ConPTY native
				// handles and its output worker after process exit; skipping it keeps the Node
				// test worker and production host alive indefinitely.
				signalOwnedPty(this.#child, "SIGKILL");
			} catch (error) {
				processGroupCleanupError = error;
			}
			this.#disposed = true;
			this.#disposing = false;
			for (const subscription of this.#subscriptions) subscription.dispose();
			this.#subscriptions.length = 0;
			this.#changeHandlers.clear();
			this.#failureHandlers.clear();
			this.#outputHandlers.clear();
			this.#terminal.dispose();
			if (processGroupCleanupError) throw processGroupCleanupError;
		}
	}

	#requireActive(): void {
		if (this.#disposed) throw new Error("terminal_projection_disposed");
	}

	#requireWritable(): void {
		this.#requireActive();
		if (this.#disposing) throw new Error("terminal_projection_disposing");
		if (this.#exitObserved) throw new Error("terminal_projection_exited");
	}
}

type CellReader = Readonly<{
	getFgColor(): number;
	getBgColor(): number;
	isFgRGB(): boolean;
	isBgRGB(): boolean;
	isFgPalette(): boolean;
	isBgPalette(): boolean;
	isBold(): number;
	isDim(): number;
	isItalic(): number;
	isUnderline(): number;
	isBlink(): number;
	isInverse(): number;
	isInvisible(): number;
	isStrikethrough(): number;
	isOverline(): number;
}>;

function readCellStyle(cell: CellReader): TerminalCellStyle {
	return {
		foreground: readColor(cell, "foreground"),
		background: readColor(cell, "background"),
		bold: Boolean(cell.isBold()),
		dim: Boolean(cell.isDim()),
		italic: Boolean(cell.isItalic()),
		underline: Boolean(cell.isUnderline()),
		blink: Boolean(cell.isBlink()),
		inverse: Boolean(cell.isInverse()),
		invisible: Boolean(cell.isInvisible()),
		strikethrough: Boolean(cell.isStrikethrough()),
		overline: Boolean(cell.isOverline()),
	};
}

function readColor(
	cell: CellReader,
	layer: "foreground" | "background",
): TerminalCellColor {
	const color = layer === "foreground" ? cell.getFgColor() : cell.getBgColor();
	const isRgb = layer === "foreground" ? cell.isFgRGB() : cell.isBgRGB();
	if (isRgb) {
		return {
			kind: "rgb",
			red: (color >> 16) & 0xff,
			green: (color >> 8) & 0xff,
			blue: color & 0xff,
		};
	}
	const isPalette =
		layer === "foreground" ? cell.isFgPalette() : cell.isBgPalette();
	return isPalette ? { kind: "indexed", index: color } : { kind: "default" };
}

function emptyCell(): TerminalProjectionCell {
	return {
		text: "",
		width: 1,
		style: {
			foreground: { kind: "default" },
			background: { kind: "default" },
			bold: false,
			dim: false,
			italic: false,
			underline: false,
			blink: false,
			inverse: false,
			invisible: false,
			strikethrough: false,
			overline: false,
		},
	};
}

function signalPty(child: nodePty.IPty, signal: NodeJS.Signals): void {
	// node-pty does not accept signal arguments on Windows; closing the ConPTY is
	// the only supported exact PTY termination operation.
	if (process.platform === "win32") {
		child.kill();
		return;
	}
	child.kill(signal);
}

function signalOwnedPty(child: nodePty.IPty, signal: NodeJS.Signals): void {
	if (process.platform === "win32") {
		child.kill();
		return;
	}
	signalOwnedProcessGroup(child.pid, signal);
}

function signalOwnedProcessGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch (error) {
		if (hasCode(error, "ESRCH")) return;
		throw error;
	}
}

function hasCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error
		&& (error as NodeJS.ErrnoException).code === code;
}

function requireDimension(name: string, value: number): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`invalid_terminal_${name}: expected a positive integer`);
	}
}
