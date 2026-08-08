// PROTOTYPE (#62): throwaway validation of the full-window child-view overlay
// presentation design. Each overlay runs Pi's REAL InteractiveMode constructor
// against a stub runtime (session + absorbed callbacks), so every field the
// borrowed private rendering methods touch is Pi's own initialization — per
// child, per overlay, zero shared state. The instance's render pump is
// redirected at the overlay TUI (Owner chrome neutered), its chat container is
// a fresh component tree, and the Owner's live chat container, editor, and
// terminal are never touched. Remove this module with the prototype verdict.
import type {
	AgentSession,
	ExtensionUIContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	getKeybindings,
	Key,
	matchesKey,
	setKeybindings,
	visibleWidth,
	type Component,
	type Container,
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
	// ctor-initialized fields (real InteractiveMode constructor)
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
	// side-effect stubs (methods that would write to the inert instance's
	// terminal, the Owner's chrome, or uninitialized native surface)
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
	// real methods, safe on the per-instance state (statusContainer is the
	// instance's own; the ui facade forwards requestRender)
	"showStatusIndicator",
	"clearStatusIndicator",
	// inherited convenience getters over runtimeHost
	"session",
	"sessionManager",
	"settingsManager",
	// inherited; never invoked because the shadow sets isInitialized = true
	"init",
]);

type SessionEvent = Parameters<Parameters<AgentSession["subscribe"]>[0]>[0];

// The InteractiveMode constructor only uses the runtime to read the session
// (via getters) and to register two callbacks the shadow never triggers.
type StubRuntimeHost = {
	session: AgentSession;
	setBeforeSessionInvalidate(callback: () => void): void;
	setRebindSession(callback: () => Promise<void>): void;
};

export type ChildViewShadowHost = {
	runtimeHost: { session: AgentSession };
	chatContainer: Container;
	statusContainer: Container;
	ui: TUI;
	pendingTools: Map<string, unknown>;
	streamingComponent: unknown;
	streamingMessage: unknown;
	toolOutputExpanded: boolean;
	hideThinkingBlock: boolean;
	outputPad: number;
	hiddenThinkingLabel: string;
	mermaidMarkdownTransformer: unknown;
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
	interactiveModeClass: unknown;
	session: AgentSession;
	tui: TUI;
}): ChildViewShadowHost {
	const { interactiveModeClass, session, tui } = options;
	const InteractiveModeClass = interactiveModeClass as new (
		runtimeHost: StubRuntimeHost,
		options?: { verbose?: boolean },
	) => ChildViewShadowHost;
	const stubRuntime: StubRuntimeHost = {
		session,
		setBeforeSessionInvalidate() {},
		setRebindSession() {},
	};
	// The constructor writes two module-global registries. Keybindings are
	// restored so the Owner's live components keep the instance they already
	// use; themes are re-registered from the same session sources (idempotent
	// same-name writes).
	const previousKeybindings = getKeybindings();
	const shadow = new InteractiveModeClass(stubRuntime, { verbose: false });
	setKeybindings(previousKeybindings);
	// Real ctor state, redirected: the render pump points at the overlay TUI
	// (Owner-chrome side effects neutered), and init() is skipped because the
	// shadow chat container is already usable.
	shadow.isInitialized = true;
	shadow.ui = createOverlayUiFacade(tui);
	for (const member of [
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
	// The real methods (clearStatusIndicator) read this; the headless test TUI
	// does not provide it, and the overlay must not depend on it anyway.
	if (typeof facade.getClearOnShrink !== "function") {
		facade.getClearOnShrink = () => false;
	}
	return facade;
}

// ---------------------------------------------------------------------------
// Full-window overlay
// ---------------------------------------------------------------------------

export function openChildViewOverlay(options: {
	interactiveModeClass: unknown;
	ui: ExtensionUIContext;
	session: AgentSession;
	agentLabel: string;
}): Promise<"closed"> {
	const { interactiveModeClass, ui, session, agentLabel } = options;
	return ui.custom<"closed">(
		(tui, theme, _keybindings, done) => {
			const shadow = createChildViewShadowHost({
				interactiveModeClass,
				session,
				tui,
			});
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
				// Escape mid-work must stop the spinner animation timer; otherwise
				// the Loader interval keeps the shadow alive and renders forever.
				(shadow as unknown as {
					activeStatusIndicator?: { dispose(): void };
				}).activeStatusIndicator?.dispose();
				done("closed");
			};
			return new ChildViewOverlayComponent({
				tui,
				theme,
				agentLabel,
				chat: shadow.chatContainer,
				status: shadow.statusContainer,
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
	readonly #status: Container;
	readonly #close: () => void;

	constructor(options: {
		tui: TUI;
		theme: Theme;
		agentLabel: string;
		chat: Container;
		status: Container;
		close(): void;
	}) {
		this.#tui = options.tui;
		this.#theme = options.theme;
		this.#agentLabel = options.agentLabel;
		this.#chat = options.chat;
		this.#status = options.status;
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
			// Per-overlay working indicator: the shadow instance's real
			// statusContainer tracks the child's spinner (agent_start shows it,
			// agent_end clears it) — each overlay owns its own, so the Owner's
			// singleton is never shared.
			...this.#status.render(width),
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
