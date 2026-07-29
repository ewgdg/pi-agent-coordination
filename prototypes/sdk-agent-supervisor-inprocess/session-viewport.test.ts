import assert from "node:assert/strict";
import test from "node:test";

import xtermHeadless from "@xterm/headless";
import type { Component, Terminal } from "@earendil-works/pi-tui";
import { TUI } from "@earendil-works/pi-tui";

import { getHostPiSdk } from "./runtime-capture.ts";

const { Terminal: XtermTerminal } = xtermHeadless;

const TERMINAL_COLUMNS = 80;
const TERMINAL_ROWS = 12;

class MutableTranscript implements Component {
	lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	invalidate(): void {}

	render(): string[] {
		return this.lines;
	}
}

class HeadlessTerminal implements Terminal {
	readonly #xterm = new XtermTerminal({
		allowProposedApi: true,
		cols: TERMINAL_COLUMNS,
		rows: TERMINAL_ROWS,
		scrollback: 100,
	});
	#pendingWrites = Promise.resolve();

	get columns(): number {
		return TERMINAL_COLUMNS;
	}

	get rows(): number {
		return TERMINAL_ROWS;
	}

	get kittyProtocolActive(): boolean {
		return false;
	}

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	moveBy(): void {}

	write(data: string): void {
		this.#pendingWrites = this.#pendingWrites.then(
			() => new Promise<void>((resolve) => this.#xterm.write(data, resolve)),
		);
	}

	async settle(): Promise<void> {
		await new Promise<void>((resolve) => setImmediate(resolve));
		await new Promise<void>((resolve) => setImmediate(resolve));
		await this.#pendingWrites;
	}

	bottomViewportLine(): string {
		this.#xterm.scrollToBottom();
		const buffer = this.#xterm.buffer.active;
		return (
			buffer
				.getLine(buffer.viewportY + TERMINAL_ROWS - 1)
				?.translateToString(true)
				.trim() ?? ""
		);
	}
}

function transcript(agent: string, lineCount: number): string[] {
	const sharedHeader = Array.from(
		{ length: 10 },
		(_, index) => `Shared Pi layout ${index + 1}`,
	);
	return [
		...sharedHeader,
		...Array.from(
			{ length: lineCount - sharedHeader.length - 1 },
			(_, index) => `${agent} transcript ${index + 1}`,
		),
		`${agent} FOOTER`,
	];
}

test("switching to a shorter retained session keeps its footer on the bottom row", async () => {
	const { InteractiveMode } = getHostPiSdk();
	const terminal = new HeadlessTerminal();
	const tui = new TUI(terminal);
	const visibleTranscript = new MutableTranscript(transcript("Researcher", 20));
	tui.addChild(visibleTranscript);
	tui.requestRender(true);
	await terminal.settle();
	const researcherSession = { isStreaming: false };
	const ownerSession = { isStreaming: false };
	const runtimeHost = { session: researcherSession };

	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost,
		ui: tui,
		applyRuntimeSettings() {},
		renderCurrentSessionState() {
			visibleTranscript.lines =
				runtimeHost.session === ownerSession
					? transcript("Owner", 18)
					: transcript("Researcher", 20);
			tui.requestRender();
		},
		async bindCurrentSessionExtensions() {},
		subscribeToAgent() {},
		async updateAvailableProviderCount() {},
		updateEditorBorderColor() {},
		updateTerminalTitle() {},
		clearStatusIndicator() {},
		setWorkingVisible() {},
	}) as InstanceType<typeof InteractiveMode>;

	const rebindCurrentSession = (
		mode as unknown as {
			rebindCurrentSession(options: { renderBeforeBind: boolean }): Promise<void>;
		}
	).rebindCurrentSession.bind(mode);
	await rebindCurrentSession({ renderBeforeBind: true });
	runtimeHost.session = ownerSession;
	await rebindCurrentSession({ renderBeforeBind: true });
	await terminal.settle();

	assert.equal(terminal.bottomViewportLine(), "Owner FOOTER");
});
