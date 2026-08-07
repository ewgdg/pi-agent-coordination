import type {
	AgentSession,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

type ExtensionBindings = Parameters<AgentSession["bindExtensions"]>[0];

export type NativeExtensionUIState = Readonly<{
	editorComponent: ReturnType<ExtensionUIContext["getEditorComponent"]>;
}>;

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

export function setNativeExtensionUIState(
	session: AgentSession,
	state: NativeExtensionUIState,
): void {
	const bound = session as unknown as BoundSession;
	bound._nativeExtensionUIState = state;
}

export function restoreNativeExtensionUIState(
	session: AgentSession,
	state: NativeExtensionUIState,
): void {
	const bound = session as unknown as BoundSession;
	bound._nativeExtensionUIState = state;
	bound._extensionUIContext?.setEditorComponent(state.editorComponent);
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
