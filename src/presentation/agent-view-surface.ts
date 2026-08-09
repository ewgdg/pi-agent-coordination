import type {
	ExtensionUIContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	type Component,
	type OverlayHandle,
	type TUI,
} from "@earendil-works/pi-tui";

import {
	addPrioritizedTuiInputListener,
	type PiNativeAgentProjection,
} from "../pi-integration/native-agent-projection.ts";

const COMPACT_AGENT_IDENTITY_LENGTH = 8;
const HEADER_ROWS = 1;
const ENABLE_MOUSE_REPORTING = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h";
const DISABLE_MOUSE_REPORTING = "\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l";

export type DurableAgentView = Readonly<{
	agentId: string;
	label: string;
	projection(): PiNativeAgentProjection;
	addChangeHandler(handler: () => void): () => void;
	addCloseHandler(handler: () => void): () => void;
	fail(error: unknown): void;
	close(): Promise<void>;
}>;

export async function openAgentViewSurface(
	ui: ExtensionUIContext,
	view: DurableAgentView,
	options: Readonly<{ requestShutdown(): void }> = {
		requestShutdown: () => undefined,
	},
): Promise<void> {
	let component: AgentViewSurface | undefined;
	let handle: OverlayHandle | undefined;
	let closedByHost = false;
	let settleHostClose!: () => void;
	const hostClose = new Promise<void>((resolve) => {
		settleHostClose = resolve;
	});
	const closeFromHost = () => {
		if (closedByHost) return;
		closedByHost = true;
		handle?.hide();
		component?.dispose();
		settleHostClose();
	};
	try {
		const interactiveClose = ui.custom<void>(
			(tui, theme, _keybindings, _done) => {
				component = new AgentViewSurface(
					tui,
					theme,
					view,
					closeFromHost,
					options.requestShutdown,
					(error) => {
						try {
							view.fail(error);
						} finally {
							closeFromHost();
						}
					},
				);
				return component;
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "top-left",
					width: "100%",
					maxHeight: "100%",
					margin: 0,
				},
				onHandle: (overlayHandle) => {
					handle = overlayHandle;
					if (closedByHost) overlayHandle.hide();
				},
			},
		);
		// Host-driven disposal must hide this exact overlay rather than Pi's
		// visual-frontmost overlay, which may belong to the child mode itself.
		await Promise.race([interactiveClose, hostClose]);
	} finally {
		await view.close();
	}
}

class AgentViewSurface implements Component {
	readonly #tui: TUI;
	readonly #theme: Theme;
	readonly #view: DurableAgentView;
	readonly #removeChangeHandler: () => void;
	readonly #removeCloseHandler: () => void;
	readonly #removePrioritizedInputListener: () => void;
	readonly #ownsMouseReporting: boolean;
	readonly #failFromSurface: (error: unknown) => void;
	#observedFailureProjection: PiNativeAgentProjection | undefined;
	#removeProjectionFailureHandler: () => void = () => undefined;
	#observedExitProjection: PiNativeAgentProjection | undefined;
	#removeProjectionExitRequestHandler: () => void = () => undefined;
	#shutdownRequested = false;
	#disposed = false;
	#failed = false;

	constructor(
		tui: TUI,
		theme: Theme,
		view: DurableAgentView,
		closeFromHost: () => void,
		requestShutdown: () => void,
		failFromSurface: (error: unknown) => void,
	) {
		this.#tui = tui;
		this.#theme = theme;
		this.#view = view;
		this.#failFromSurface = failFromSurface;
		this.#removeChangeHandler = view.addChangeHandler(() => {
			this.#observeProjectionEvents(requestShutdown);
			this.#tui.requestRender();
		});
		this.#observeProjectionEvents(requestShutdown);
		this.#removeCloseHandler = view.addCloseHandler(closeFromHost);
		this.#removePrioritizedInputListener = addPrioritizedTuiInputListener(
			tui,
			(data) => {
				try {
					const childInput = translateMouseInputToChildFrame(data);
					if (childInput !== undefined) {
						this.#view.projection().dispatchInput(childInput);
						this.#tui.requestRender();
					}
				} catch (error) {
					this.#fail(error);
				}
				// Fullscreen Owner viewport listeners otherwise consume wheel, drag,
				// Page/Home/End, and prompt-navigation input before the focused overlay.
				return { consume: true };
			},
		);
		// A fullscreen child writes mouse-mode setup only to its detached terminal.
		// Regular Owner TUI therefore needs this view-owned physical mouse lease.
		this.#ownsMouseReporting = tui.mode === "regular";
		if (this.#ownsMouseReporting) {
			this.#tui.terminal.write(ENABLE_MOUSE_REPORTING);
		}
	}

	handleInput(data: string): void {
		// The child TUI owns editor keys, extension input listeners, shortcuts,
		// overlays, and submission. Navigation back to Owner happens through
		// /agents rather than stealing Escape from custom editors such as pi-vim.
		try {
			const childInput = translateMouseInputToChildFrame(data);
			if (childInput === undefined) return;
			this.#view.projection().dispatchInput(childInput);
			this.#tui.requestRender();
		} catch (error) {
			this.#fail(error);
		}
	}

	render(width: number): string[] {
		try {
			return this.#render(width);
		} catch (error) {
			this.#fail(error);
			const safeWidth = Math.max(1, width);
			const terminalRows = Math.max(1, Math.floor(this.#tui.terminal.rows));
			return [
				truncateToWidth("Agent view failed; returning to Owner…", safeWidth, ""),
				...Array.from({ length: terminalRows - 1 }, () => ""),
			];
		}
	}

	#render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const projection = this.#view.projection();
		const terminalRows = Math.max(1, Math.floor(this.#tui.terminal.rows));
		const phase = projection.kind === "live" ? "Live" : "Dormant";
		const compactIdentity = this.#view.agentId.slice(-COMPACT_AGENT_IDENTITY_LENGTH);
		const headerContent = this.#theme.fg(
			"accent",
			this.#theme.bold(`${this.#view.label} · ${compactIdentity} · ${phase}`),
		);
		const header = this.#theme.bg(
			"selectedBg",
			truncateToWidth(headerContent, safeWidth, "", true),
		);
		const headerLines = [header].slice(0, Math.min(HEADER_ROWS, terminalRows));
		const availableRows = terminalRows - headerLines.length;
		if (availableRows > 0) projection.resize(safeWidth, availableRows);
		const nativeFrame = projection.presentation
			.render(safeWidth)
			.map((line) => truncateToWidth(line, safeWidth, ""));
		const visibleFrame = availableRows === 0
			? []
			: nativeFrame.slice(-availableRows);
		const topPadding = Array.from(
			{ length: Math.max(0, availableRows - visibleFrame.length) },
			() => "",
		);
		return [...headerLines, ...topPadding, ...visibleFrame];
	}

	invalidate(): void {
		try {
			this.#view.projection().presentation.invalidate();
		} catch (error) {
			this.#fail(error);
		}
	}

	#fail(error: unknown): void {
		if (this.#failed || this.#disposed) return;
		this.#failed = true;
		this.#failFromSurface(error);
	}

	#observeProjectionEvents(requestShutdown: () => void): void {
		const projection = this.#view.projection();
		if (projection !== this.#observedFailureProjection) {
			this.#removeProjectionFailureHandler();
			this.#observedFailureProjection = projection;
			this.#removeProjectionFailureHandler = projection.addFailureHandler((error) => {
				this.#fail(error);
			});
		}
		if (projection === this.#observedExitProjection) return;
		this.#removeProjectionExitRequestHandler();
		this.#observedExitProjection = projection;
		this.#removeProjectionExitRequestHandler = projection.addExitRequestHandler(() => {
			if (this.#shutdownRequested || this.#disposed) return;
			this.#shutdownRequested = true;
			requestShutdown();
		});
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#removeChangeHandler();
		this.#removeCloseHandler();
		this.#removeProjectionFailureHandler();
		this.#removeProjectionExitRequestHandler();
		this.#removePrioritizedInputListener();
		if (this.#ownsMouseReporting) {
			this.#tui.terminal.write(DISABLE_MOUSE_REPORTING);
		}
	}
}

function translateMouseInputToChildFrame(data: string): string | undefined {
	const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
	if (match) {
		const physicalRow = Number(match[3]);
		if (physicalRow <= HEADER_ROWS) return undefined;
		return `\x1b[<${match[1]};${match[2]};${physicalRow - HEADER_ROWS}${match[4]}`;
	}
	if (data.length === 6 && data.startsWith("\x1b[M")) {
		const physicalRow = data.charCodeAt(5) - 32;
		if (physicalRow <= HEADER_ROWS) return undefined;
		return `${data.slice(0, 5)}${String.fromCharCode(data.charCodeAt(5) - HEADER_ROWS)}`;
	}
	return data;
}
