// PROTOTYPE (#62): throwaway validation of the full-window child-view overlay
// presentation design. It borrows Pi's private InteractiveMode rendering methods
// (`renderSessionEntries` / `addMessageToChat` / `addCustomEntryToChat` /
// `handleEvent`) and runs them against a shadow host whose chat container is a
// fresh component tree — the Owner's live chat container, editor, and terminal
// chrome are never touched. Remove this module with the prototype verdict.
import type {
	AgentSession,
	ExtensionUIContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Key,
	matchesKey,
	visibleWidth,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Shadow host
// ---------------------------------------------------------------------------

// Every `this.<member>` access the borrowed private methods make must be
// provided by the shadow host. The upgrade guard
// (tests/child-view-upgrade-guard.test.ts) extracts `this.X` from the pinned
// private-method spans in Pi's dist and fails mechanically when a new member
// appears outside this set — per-release breakage becomes a test failure.
export const SHADOW_HOST_MEMBERS: ReadonlySet<string> = new Set([
	// fields
	"runtimeHost",
	"isInitialized",
	"chatContainer",
	"pendingTools",
	"streamingComponent",
	"streamingMessage",
	"toolOutputExpanded",
	"hideThinkingBlock",
	"outputPad",
	"hiddenThinkingLabel",
	"mermaidMarkdownTransformer",
	"footer",
	"defaultEditor",
	"editor",
	"ui",
	"workingVisible",
	"workingMessage",
	"defaultWorkingMessage",
	"workingIndicatorOptions",
	"retryEscapeHandler",
	"autoCompactionEscapeHandler",
	// side-effect stubs (native members these write to are not shadowed)
	"clearStatusIndicator",
	"showStatusIndicator",
	"updatePendingMessagesDisplay",
	"updateTerminalTitle",
	"updateEditorBorderColor",
	"checkShutdownRequested",
	"flushCompactionQueue",
	"showError",
	"showStatus",
	// real borrowed methods (inherited from the host prototype)
	"handleEvent",
	"renderSessionEntries",
	"renderSessionItems",
	"addMessageToChat",
	"addCustomEntryToChat",
	"getUserMessageText",
	"getMarkdownThemeWithSettings",
	"getMarkdownTransformers",
	"getRegisteredToolDefinition",
	"addCacheMissNotice",
	"maybeShowCacheMissNotice",
	"rebuildChatFromMessages",
	// inherited convenience getters over runtimeHost
	"session",
	"sessionManager",
	"settingsManager",
	// inherited; never invoked because the shadow sets isInitialized = true
	"init",
]);

type SessionEvent = Parameters<Parameters<AgentSession["subscribe"]>[0]>[0];

export type ChildViewShadowHost = {
	runtimeHost: { session: AgentSession };
	chatContainer: Container;
	ui: TUI;
	pendingTools: Map<string, unknown>;
	streamingComponent: unknown;
	streamingMessage: unknown;
	toolOutputExpanded: boolean;
	hideThinkingBlock: boolean;
	outputPad: number;
	hiddenThinkingLabel: string;
	mermaidMarkdownTransformer: {
		transform(markdown: string, availableWidth: number): string;
	};
	footer: { invalidate(): void };
	defaultEditor: { onEscape: unknown };
	editor: { addToHistory?: unknown };
	isInitialized: boolean;
	// Convenience accessors inherited from InteractiveMode.prototype over runtimeHost.
	readonly session: AgentSession;
	readonly sessionManager: AgentSession["sessionManager"];
	readonly settingsManager: AgentSession["settingsManager"];
	// Borrowed private rendering methods (present on the host prototype).
	renderSessionEntries(entries: readonly unknown[], options?: unknown): void;
	handleEvent(event: SessionEvent): Promise<void>;
};

export function createChildViewShadowHost(options: {
	prototype: object;
	session: AgentSession;
	tui: TUI;
}): ChildViewShadowHost {
	const { prototype, session, tui } = options;
	const shadow = Object.create(prototype) as unknown as ChildViewShadowHost;
	// The prototype's `session`/`sessionManager`/`settingsManager`/`agent`
	// getters read `runtimeHost` — a single-session runtime is all they need.
	shadow.runtimeHost = { session };
	shadow.isInitialized = true;
	shadow.chatContainer = new Container();
	shadow.pendingTools = new Map();
	shadow.streamingComponent = undefined;
	shadow.streamingMessage = undefined;
	shadow.toolOutputExpanded = false;
	shadow.hideThinkingBlock = shadow.settingsManager.getHideThinkingBlock();
	shadow.outputPad = shadow.settingsManager.getOutputPad();
	shadow.hiddenThinkingLabel = "Thinking…";
	// Known prototype gap: the native mermaid transformer lives module-private
	// in interactive-mode.js and is not borrowable; a pass-through keeps the
	// shadow renderable. Measured in the parity test and reported in the verdict.
	shadow.mermaidMarkdownTransformer = {
		transform: (markdown) => markdown,
	};
	shadow.footer = { invalidate() {} };
	shadow.defaultEditor = { onEscape: undefined };
	// `addMessageToChat` only touches `editor` under `populateHistory`, which
	// the read-only view never requests; kept for the upgrade guard surface.
	shadow.editor = { addToHistory: undefined };
	// Read-only child view: the owner's terminal progress indicator is chrome
	// the overlay must not touch, so the facade no-ops it and forwards the rest.
	shadow.ui = createOverlayUiFacade(tui);
	for (const member of [
		"clearStatusIndicator",
		"showStatusIndicator",
		"updatePendingMessagesDisplay",
		"updateTerminalTitle",
		"updateEditorBorderColor",
		"checkShutdownRequested",
		"flushCompactionQueue",
		"showError",
		"showStatus",
	] as const) {
		(shadow as unknown as Record<string, unknown>)[member] = () => undefined;
	}
	return shadow;
}

function createOverlayUiFacade(tui: TUI): TUI {
	const facade = Object.create(tui) as TUI & { terminal: TUI["terminal"] };
	facade.terminal = new Proxy(tui.terminal, {
		get(target, property, receiver) {
			if (property === "setProgress") return () => undefined;
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return facade;
}

// ---------------------------------------------------------------------------
// Full-window overlay
// ---------------------------------------------------------------------------

export function openChildViewOverlay(options: {
	prototype: object;
	ui: ExtensionUIContext;
	session: AgentSession;
	agentLabel: string;
}): Promise<"closed"> {
	const { prototype, ui, session, agentLabel } = options;
	return ui.custom<"closed">(
		(tui, theme, _keybindings, done) => {
			const shadow = createChildViewShadowHost({ prototype, session, tui });
			const unsubscribe = session.subscribe((event) => {
				void shadow.handleEvent(event).catch((error: unknown) => {
					ui.notify(
						`[child-view] event rendering failed: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				});
			});
			shadow.renderSessionEntries(shadow.sessionManager.buildContextEntries());
			let closed = false;
			const close = () => {
				if (closed) return;
				closed = true;
				unsubscribe();
				done("closed");
			};
			return new ChildViewOverlayComponent({
				tui,
				theme,
				agentLabel,
				chat: shadow.chatContainer,
				close,
			});
		},
		{
			overlay: true,
			overlayOptions: {
				width: "100%",
				anchor: "top-left",
				margin: 0,
			},
		},
	);
}

export class ChildViewOverlayComponent implements Component {
	readonly #tui: TUI;
	readonly #theme: Theme;
	readonly #agentLabel: string;
	readonly #chat: Container;
	readonly #close: () => void;

	constructor(options: {
		tui: TUI;
		theme: Theme;
		agentLabel: string;
		chat: Container;
		close(): void;
	}) {
		this.#tui = options.tui;
		this.#theme = options.theme;
		this.#agentLabel = options.agentLabel;
		this.#chat = options.chat;
		this.#close = options.close;
	}

	// Constant full-screen height: the component always emits exactly
	// `terminal.rows` lines, so Pi's differential renderer never sees a height
	// change while the child streams — the redraw-artifact class that partial
	// overlays suffer is structurally excluded.
	render(width: number): string[] {
		const rows = Math.max(1, this.#tui.terminal.rows);
		const headerText = `─ CHILD VIEW · ${this.#agentLabel} · read-only · Esc to close`;
		const pad = Math.max(1, width - visibleWidth(headerText));
		const lines = [
			this.#theme.fg("accent", `${headerText}${"─".repeat(pad)}`),
			...this.#chat.render(width),
		];
		while (lines.length < rows) lines.push("");
		return lines.slice(0, rows);
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) this.#close();
	}

	invalidate(): void {
		this.#chat.invalidate();
	}
}
