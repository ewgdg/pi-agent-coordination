import type {
	AgentSessionRuntime,
	AutocompleteProviderFactory,
	ExtensionUIContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

import {
	assertHostModuleShape,
	assertInteractiveModeInstanceShape,
	assertRuntimeInstanceShape,
} from "./host-shape.ts";
import {
	hasInstalledExtensionBindings,
	refreshNativeExtensionBindings,
} from "./extension-bindings.ts";

type HostModule = {
	VERSION?: unknown;
	InteractiveMode: {
		prototype: {
			bindCurrentSessionExtensions(): Promise<void>;
		};
	};
};

type RuntimeWaiter = {
	sessionManager: SessionManager;
	resolve(runtime: AgentSessionRuntime): void;
	reject(error: unknown): void;
};

type BridgeState = {
	runtimesBySessionManager: WeakMap<SessionManager, WeakRef<AgentSessionRuntime>>;
	waiters: RuntimeWaiter[];
};

export type InteractiveHostBridge = {
	captureRuntime(sessionManager: SessionManager): Promise<AgentSessionRuntime>;
};

const BRIDGE_REGISTRY_KEY = "__piAgentCoordinationInteractiveHostBridge";
const CHILD_NATIVE_SESSION_REGISTRY_KEY = "__piAgentCoordinationChildNativeSessions";
const globalBridgeRegistry = globalThis as typeof globalThis & {
	[BRIDGE_REGISTRY_KEY]?: WeakMap<object, BridgeState>;
	[CHILD_NATIVE_SESSION_REGISTRY_KEY]?: WeakSet<SessionManager>;
};
// Pi may re-evaluate extension modules during resource reload. Process-global
// ownership prevents a second evaluation from stacking private host patches.
const bridgeStates = (globalBridgeRegistry[BRIDGE_REGISTRY_KEY] ??= new WeakMap());
const childNativeSessions = (
	globalBridgeRegistry[CHILD_NATIVE_SESSION_REGISTRY_KEY] ??= new WeakSet()
);
const CHILD_HIDDEN_NATIVE_COMMANDS = new Set(["resume", "fork"]);

const hideChildNativeCommands: AutocompleteProviderFactory = (current) => ({
	...(current.triggerCharacters === undefined
		? {}
		: { triggerCharacters: current.triggerCharacters }),
	async getSuggestions(lines, cursorLine, cursorCol, options) {
		const suggestions = await current.getSuggestions(
			lines,
			cursorLine,
			cursorCol,
			options,
		);
		const textBeforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
		const isNativeCommandList =
			!options.force &&
			textBeforeCursor.startsWith("/") &&
			!textBeforeCursor.includes(" ");
		if (!suggestions || !isNativeCommandList) return suggestions;
		const items = suggestions.items.filter(
			({ value }) => !CHILD_HIDDEN_NATIVE_COMMANDS.has(value),
		);
		return items.length === 0 ? null : { ...suggestions, items };
	},
	applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
		current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
	...(current.shouldTriggerFileCompletion === undefined
		? {}
		: {
			shouldTriggerFileCompletion: (lines: string[], cursorLine: number, cursorCol: number) =>
				current.shouldTriggerFileCompletion!(lines, cursorLine, cursorCol),
		}),
});

export function markChildNativeSession(sessionManager: SessionManager): void {
	childNativeSessions.add(sessionManager);
}

export function installInteractiveHostBridge(hostValue: unknown): InteractiveHostBridge {
	assertHostModuleShape(hostValue);
	const host = hostValue as HostModule & object;
	// Pi's reload loader recreates the host module namespace while reusing the
	// running host constructors. The prototype is the stable seam we mutate and
	// therefore remains the ownership key across those namespace re-evaluations.
	const bridgeKey = host.InteractiveMode.prototype;
	let state = bridgeStates.get(bridgeKey);
	if (!state) {
		state = installRuntimeCapture(host);
		bridgeStates.set(bridgeKey, state);
	}

	return {
		captureRuntime(sessionManager) {
			const runtime = state.runtimesBySessionManager.get(sessionManager)?.deref();
			if (runtime) return Promise.resolve(runtime);
			return new Promise((resolve, reject) =>
				state.waiters.push({ sessionManager, resolve, reject })
			);
		},
	};
}

function installRuntimeCapture(host: HostModule): BridgeState {
	const state: BridgeState = {
		runtimesBySessionManager: new WeakMap(),
		waiters: [],
	};
	const interactivePrototype = host.InteractiveMode.prototype;
	const originalBindCurrentSessionExtensions =
		interactivePrototype.bindCurrentSessionExtensions;

	const captureValidatedInteractiveRuntime =
		async function captureValidatedInteractiveRuntime(this: unknown): Promise<void> {
			let runtime: AgentSessionRuntime;
			try {
				assertInteractiveModeInstanceShape(this, host.VERSION);
				const runtimeValue = (this as { runtimeHost: unknown }).runtimeHost;
				assertRuntimeInstanceShape(runtimeValue, host.VERSION);
				runtime = runtimeValue;
			} catch (error) {
				// A live structural rejection is still startup failure. Restore the
				// native prototype and reject capture waiters so no patch or pending
				// bootstrap remains installed after incompatible admission.
				if (
					interactivePrototype.bindCurrentSessionExtensions ===
					captureValidatedInteractiveRuntime
				) {
					interactivePrototype.bindCurrentSessionExtensions =
						originalBindCurrentSessionExtensions;
				}
				bridgeStates.delete(host.InteractiveMode.prototype);
				for (const waiter of state.waiters.splice(0)) waiter.reject(error);
				throw error;
			}
			const sessionManager = runtime.session.sessionManager;
			// TUI binding is Pi's first mode-specific seam. Keep this association weak
			// so failed startup never turns runtime discovery into host retention.
			state.runtimesBySessionManager.set(sessionManager, new WeakRef(runtime));
			for (const waiter of [...state.waiters]) {
				if (waiter.sessionManager !== sessionManager) continue;
				state.waiters.splice(state.waiters.indexOf(waiter), 1);
				waiter.resolve(runtime);
			}
			if (!hasInstalledExtensionBindings(runtime.session)) {
				await originalBindCurrentSessionExtensions.call(this);
			} else {
				await refreshNativeExtensionBindings(runtime.session, () =>
					originalBindCurrentSessionExtensions.call(this),
				);
			}
			applyChildNativeCommandPresentation(this, runtime.session.sessionManager);
			requestFullInteractiveRender(this);
		};
	interactivePrototype.bindCurrentSessionExtensions =
		captureValidatedInteractiveRuntime;

	return state;
}

function applyChildNativeCommandPresentation(
	interactiveMode: unknown,
	sessionManager: SessionManager,
): void {
	if (!childNativeSessions.has(sessionManager)) return;
	// Native slash commands live above AgentSession and cannot be unregistered.
	// Apply the public autocomplete wrapper only after Pi binds the selected session.
	const uiContext = (interactiveMode as {
		createExtensionUIContext(): ExtensionUIContext;
	}).createExtensionUIContext();
	uiContext.addAutocompleteProvider(hideChildNativeCommands);
}

function requestFullInteractiveRender(interactiveMode: unknown): void {
	const interactive = interactiveMode as {
		ui: { requestRender(force?: boolean): void };
	};
	// Differential rendering cannot erase rows left by a longer deselected
	// transcript. A retained-session replacement therefore needs one native full
	// redraw after Pi reconstructs the selected session's complete presentation.
	interactive.ui.requestRender(true);
}
