import type {
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
	isFocusable,
	truncateToWidth,
	type Component,
	type Focusable,
	type OverlayHandle,
	type TUI,
} from "@earendil-works/pi-tui";

import { addPrioritizedTuiInputListener } from "../pi-integration/native-agent-projection.ts";
import type { TerminalProjection } from "./terminal-projection.ts";

const ENABLE_MOUSE_REPORTING = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h";
const DISABLE_MOUSE_REPORTING = "\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l";

export type DurableAgentView = Readonly<{
	agentId: string;
	label: string;
	projection(): TerminalProjection;
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
			(tui, _theme, _keybindings, _done) => {
				component = new AgentViewSurface(
					tui,
					view,
					() => handle?.isFocused() ?? true,
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

class AgentViewSurface implements Component, Focusable {
	readonly #tui: TUI;
	readonly #view: DurableAgentView;
	readonly #removeChangeHandler: () => void;
	readonly #removeCloseHandler: () => void;
	readonly #removePrioritizedInputListener: () => void;
	readonly #ownsInput: () => boolean;
	readonly #ownsMouseReporting: boolean;
	readonly #failFromSurface: (error: unknown) => void;
	#observedFailureProjection: TerminalProjection | undefined;
	#removeProjectionFailureHandler: () => void = () => undefined;
	#observedExitProjection: TerminalProjection | undefined;
	#removeProjectionExitRequestHandler: () => void = () => undefined;
	#shutdownRequested = false;
	#disposed = false;
	#failed = false;
	#focused = false;
	#focusedPresentation: Component | undefined;

	constructor(
		tui: TUI,
		view: DurableAgentView,
		ownsInput: () => boolean,
		closeFromHost: () => void,
		requestShutdown: () => void,
		failFromSurface: (error: unknown) => void,
	) {
		this.#tui = tui;
		this.#view = view;
		this.#ownsInput = ownsInput;
		this.#failFromSurface = failFromSurface;
		this.#removeChangeHandler = view.addChangeHandler(() => {
			this.#synchronizePresentationFocus();
			this.#observeProjectionEvents(requestShutdown);
			this.#tui.requestRender();
		});
		this.#observeProjectionEvents(requestShutdown);
		this.#removeCloseHandler = view.addCloseHandler(closeFromHost);
		this.#removePrioritizedInputListener = addPrioritizedTuiInputListener(
			tui,
			(data) => {
				// A newer Owner overlay must keep the focus it acquired above this
				// fullscreen child instead of having its input stolen by the child.
				if (!this.#ownsInput()) return undefined;
				try {
					this.#view.projection().dispatchInput(data);
					this.#tui.requestRender();
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

	get focused(): boolean {
		return this.#focused;
	}

	set focused(value: boolean) {
		this.#focused = value;
		this.#synchronizePresentationFocus();
	}

	handleInput(data: string): void {
		// The child TUI owns editor keys, extension input listeners, shortcuts,
		// overlays, and submission. Navigation back to Owner happens through
		// /agents rather than stealing Escape from custom editors such as pi-vim.
		try {
			this.#view.projection().dispatchInput(data);
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
		projection.resize(safeWidth, terminalRows);
		const nativeFrame = projection.presentation
			.render(safeWidth)
			.map((line) => truncateToWidth(line, safeWidth, ""));
		const visibleFrame = nativeFrame.slice(-terminalRows);
		const topPadding = Array.from(
			{ length: Math.max(0, terminalRows - visibleFrame.length) },
			() => "",
		);
		return [...topPadding, ...visibleFrame];
	}

	invalidate(): void {
		try {
			this.#view.projection().presentation.invalidate();
		} catch (error) {
			this.#fail(error);
		}
	}

	#synchronizePresentationFocus(): void {
		const presentation = this.#view.projection().presentation;
		if (presentation !== this.#focusedPresentation) {
			if (this.#focusedPresentation && isFocusable(this.#focusedPresentation)) {
				this.#focusedPresentation.focused = false;
			}
			this.#focusedPresentation = presentation;
		}
		if (isFocusable(presentation)) presentation.focused = this.#focused;
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
		if (this.#focusedPresentation && isFocusable(this.#focusedPresentation)) {
			this.#focusedPresentation.focused = false;
		}
		this.#focusedPresentation = undefined;
		if (this.#ownsMouseReporting) {
			this.#tui.terminal.write(DISABLE_MOUSE_REPORTING);
		}
	}
}
