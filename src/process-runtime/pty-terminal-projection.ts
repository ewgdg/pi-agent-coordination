import xtermHeadless from "@xterm/headless";
import * as nodePty from "node-pty";

const { Terminal } = xtermHeadless;

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

export type TerminalProjectionFrame = Readonly<{
	columns: number;
	rows: number;
	buffer: "normal" | "alternate";
	cursor: Readonly<{ column: number; row: number }>;
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
	writeInput(data: string | Buffer): void;
	resize(columns: number, rows: number): void;
	kill(signal: NodeJS.Signals): void;
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
	readonly #subscriptions: nodePty.IDisposable[] = [];
	readonly #drainWaiters = new Set<() => void>();
	#pendingWrites = 0;
	#exitObserved = false;
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
		);
		this.exited = new Promise<PtyExit>((resolve) => {
			this.#subscriptions.push(
				child.onExit((event) => {
					this.#exitObserved = true;
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
			},
			lines,
		};
	}

	writeInput(data: string | Buffer): void {
		this.#requireWritable();
		this.#child.write(data);
	}

	resize(columns: number, rows: number): void {
		this.#requireWritable();
		requireDimension("columns", columns);
		requireDimension("rows", rows);
		// The child can emit output synchronously in response to SIGWINCH, so the
		// emulator must expose the new geometry before the PTY is notified.
		this.#terminal.resize(columns, rows);
		this.#child.resize(columns, rows);
	}

	kill(signal: NodeJS.Signals): void {
		this.#requireActive();
		if (this.#exitObserved) return;
		this.#child.kill(signal);
	}

	drain(): Promise<void> {
		this.#requireActive();
		return this.#waitForParserDrain();
	}

	dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		this.#disposed = true;
		this.#disposePromise = this.#dispose();
		return this.#disposePromise;
	}

	#parseOutput(data: string): void {
		if (this.#disposed) return;
		this.#pendingWrites += 1;
		this.#terminal.write(data, () => {
			this.#pendingWrites -= 1;
			if (this.#pendingWrites === 0) {
				for (const resolve of this.#drainWaiters) resolve();
				this.#drainWaiters.clear();
			}
		});
	}

	#writeGeneratedReply(data: string | Buffer): void {
		if (this.#disposed || this.#exitObserved) return;
		this.#child.write(data);
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
		if (!this.#exitObserved) this.#child.kill();
		await this.exited;
		await this.#waitForParserDrain();
		for (const subscription of this.#subscriptions) subscription.dispose();
		this.#subscriptions.length = 0;
		this.#terminal.dispose();
	}

	#requireActive(): void {
		if (this.#disposed) throw new Error("terminal_projection_disposed");
	}

	#requireWritable(): void {
		this.#requireActive();
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

function requireDimension(name: string, value: number): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`invalid_terminal_${name}: expected a positive integer`);
	}
}
