import type {
	AgentSession,
	ExtensionUIContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type {
	Component,
	TUI,
} from "@earendil-works/pi-tui";

type ExtensionBindings = Parameters<AgentSession["bindExtensions"]>[0];

export type NativeExtensionUIState = Readonly<{
	editorComponent: ReturnType<ExtensionUIContext["getEditorComponent"]>;
}>;

export type DetachedChildNotification = Readonly<{
	message: string;
	type: "info" | "warning" | "error" | undefined;
}>;

export type DetachedChildWidgetContent =
	| readonly string[]
	| ((tui: TUI, theme: Theme) => Component & { dispose?(): void })
	| undefined;

export type DetachedChildWidget = Readonly<{
	content: DetachedChildWidgetContent;
	options: Parameters<ExtensionUIContext["setWidget"]>[2];
}>;

export type DetachedChildUIState = Readonly<{
	editorComponent: ReturnType<ExtensionUIContext["getEditorComponent"]>;
	notifications: readonly DetachedChildNotification[];
	statuses: ReadonlyMap<string, string>;
	widgets: ReadonlyMap<string, DetachedChildWidget>;
}>;

type MutableDetachedChildUIState = {
	editorComponent: DetachedChildUIState["editorComponent"];
	notifications: DetachedChildNotification[];
	statuses: Map<string, string>;
	widgets: Map<string, DetachedChildWidget>;
};

const detachedUIStates = new WeakMap<AgentSession, MutableDetachedChildUIState>();
const detachedUIContexts = new WeakMap<AgentSession, ExtensionUIContext>();

type BoundSession = {
	_extensionUIContext: ExtensionBindings["uiContext"];
	_extensionMode: ExtensionBindings["mode"];
	_extensionCommandContextActions: ExtensionBindings["commandContextActions"];
	_extensionAbortHandler: ExtensionBindings["abortHandler"];
	_extensionShutdownHandler: ExtensionBindings["shutdownHandler"];
	_extensionErrorListener: ExtensionBindings["onError"];
	// Pi clears host-owned extension UI before a native rebind. Retained sessions
	// skip session_start, so the last editor factory must survive that reset.
	_nativeExtensionUIState?: NativeExtensionUIState;
	_applyExtensionBindings(runner: AgentSession["extensionRunner"]): void;
};

export function captureNativeExtensionUIState(
	session: AgentSession,
): NativeExtensionUIState {
	const bound = session as unknown as BoundSession;
	return {
		editorComponent: bound._extensionUIContext?.getEditorComponent(),
	};
}

export function rememberNativeExtensionUIState(session: AgentSession): void {
	const bound = session as unknown as BoundSession;
	bound._nativeExtensionUIState = captureNativeExtensionUIState(session);
}

export function readNativeExtensionUIState(
	session: AgentSession,
): NativeExtensionUIState {
	const bound = session as unknown as BoundSession;
	return bound._nativeExtensionUIState ?? captureNativeExtensionUIState(session);
}

export function restoreNativeExtensionUIState(
	session: AgentSession,
	state: NativeExtensionUIState,
): void {
	const bound = session as unknown as BoundSession;
	bound._nativeExtensionUIState = state;
	bound._extensionUIContext?.setEditorComponent(state.editorComponent);
}

// The child's own session_start runs against this context. notify, editor
// registration, status, and widget writes are stored per-child and never reach
// the Owner's presentation; the remaining members settle inert so child
// extensions neither touch the Owner TUI nor hang on unanswerable prompts.
// Read-only theme access is delegated to the Owner's TUI context (captured at
// binding time), which the Owner is guaranteed to have before any child spawns.
export function createDetachedExtensionUIContext(
	session: AgentSession,
	nativeContextSource: AgentSession,
): ExtensionUIContext {
	const state: MutableDetachedChildUIState = {
		editorComponent: undefined,
		notifications: [],
		statuses: new Map(),
		widgets: new Map(),
	};
	detachedUIStates.set(session, state);
	const nativeUI = (nativeContextSource as unknown as BoundSession)
		._extensionUIContext!;
	const context: ExtensionUIContext = {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: (message, type) => {
			state.notifications.push({ message, type });
		},
		onTerminalInput: () => () => undefined,
		setStatus: (key, text) => {
			if (text === undefined) state.statuses.delete(key);
			else state.statuses.set(key, text);
		},
		setWorkingMessage: () => undefined,
		setWorkingVisible: () => undefined,
		setWorkingIndicator: () => undefined,
		setHiddenThinkingLabel: () => undefined,
		setWidget: (key, content, options) => {
			if (content === undefined) state.widgets.delete(key);
			else state.widgets.set(key, { content, options });
		},
		setFooter: () => undefined,
		setHeader: () => undefined,
		setTitle: () => undefined,
		custom: async () => undefined as never,
		pasteToEditor: () => undefined,
		setEditorText: () => undefined,
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => undefined,
		setEditorComponent: (factory) => {
			state.editorComponent = factory;
		},
		getEditorComponent: () => state.editorComponent,
		get theme() {
			return nativeUI.theme;
		},
		getAllThemes: () => nativeUI.getAllThemes(),
		getTheme: (name) => nativeUI.getTheme(name),
		setTheme: () => ({ success: false, error: "Child UI context is detached" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => undefined,
	};
	detachedUIContexts.set(session, context);
	return context;
}

// A deselected child must not keep the TUI-bound context it received for its own
// native selection: later extension UI calls would land in the newly selected
// Agent's presentation. Reinstall the child's detached context and refresh the
// captured snapshot so the next selection restores the child's own registration.
// Only sessions created by the child session factory bind a detached context;
// for anything else the missing context is a wiring bug, so fail fast.
export function reinstallDetachedExtensionUIContext(session: AgentSession): void {
	const bound = session as unknown as BoundSession;
	const context = detachedUIContexts.get(session);
	if (context === undefined) {
		throw new Error(
			"Session has no detached UI context to reinstall; only children created by the session factory bind one",
		);
	}
	bound._extensionUIContext = context;
	bound._applyExtensionBindings(session.extensionRunner);
	bound._nativeExtensionUIState = captureNativeExtensionUIState(session);
}

export function readDetachedChildUIState(
	session: AgentSession,
): DetachedChildUIState | undefined {
	return detachedUIStates.get(session);
}

// A selected presentation whose native rebind failed must keep working through
// the Owner's TUI context: it IS the presented session, so its UI calls are
// legitimate there, while the detached context would leave its surfaces inert.
export function attachNativeExtensionUIContext(
	session: AgentSession,
	nativeContextSource: AgentSession,
): void {
	const bound = session as unknown as BoundSession;
	const nativeUI = (nativeContextSource as unknown as BoundSession)
		._extensionUIContext;
	if (nativeUI === undefined) return;
	bound._extensionUIContext = nativeUI;
	bound._applyExtensionBindings(session.extensionRunner);
}

export function hasInstalledExtensionBindings(session: AgentSession): boolean {
	const bound = session as unknown as BoundSession;
	return (
		bound._extensionUIContext !== undefined ||
		bound._extensionCommandContextActions !== undefined ||
		bound._extensionShutdownHandler !== undefined ||
		bound._extensionErrorListener !== undefined
	);
}

export async function refreshNativeExtensionBindings(
	session: AgentSession,
	bindNativeExtensions: () => Promise<void>,
): Promise<void> {
	const bound = session as unknown as BoundSession;
	const nativeBindExtensions = session.bindExtensions;
	const bindingOnly: AgentSession["bindExtensions"] = async (bindings) => {
		if (bindings.uiContext !== undefined) {
			bound._extensionUIContext = bindings.uiContext;
		}
		if (bindings.mode !== undefined) {
			bound._extensionMode = bindings.mode;
		}
		if (bindings.commandContextActions !== undefined) {
			bound._extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.abortHandler !== undefined) {
			bound._extensionAbortHandler = bindings.abortHandler;
		}
		if (bindings.shutdownHandler !== undefined) {
			bound._extensionShutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			bound._extensionErrorListener = bindings.onError;
		}
		bound._applyExtensionBindings(session.extensionRunner);
	};

	// Pi's native retained-session rebind rebuilds the complete TUI but calls
	// bindExtensions(), which would replay session_start. Capture its fresh UI
	// callbacks while preserving the already-started extension lifecycle.
	session.bindExtensions = bindingOnly;
	try {
		await bindNativeExtensions();
	} finally {
		if (session.bindExtensions === bindingOnly) {
			session.bindExtensions = nativeBindExtensions;
		}
	}
}

export function copyExtensionBindings(
	source: AgentSession,
	target: AgentSession,
): ExtensionBindings {
	const bound = source as unknown as BoundSession;
	return {
		uiContext: bound._extensionUIContext,
		mode: bound._extensionMode,
		commandContextActions: bound._extensionCommandContextActions,
		abortHandler: () => {
			void target.abort();
		},
		shutdownHandler: bound._extensionShutdownHandler,
		onError: bound._extensionErrorListener,
	};
}
