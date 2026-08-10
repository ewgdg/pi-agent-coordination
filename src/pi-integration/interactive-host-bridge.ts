import type {
	AgentSessionRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

import {
	assertHostModuleShape,
	assertInteractiveModeInstanceShape,
	assertRuntimeInstanceShape,
} from "./host-shape.ts";
import {
	createPiNativeProjectionHost,
	type PiNativeProjectionHost,
} from "./native-agent-projection.ts";
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

type InteractiveCapture = Readonly<{
	runtime: AgentSessionRuntime;
	projectionHost: PiNativeProjectionHost;
}>;

type RuntimeWaiter = {
	sessionManager: SessionManager;
	resolve(capture: InteractiveCapture): void;
	reject(error: unknown): void;
};

type BridgeState = {
	capturesBySessionManager: WeakMap<SessionManager, InteractiveCapture>;
	waiters: RuntimeWaiter[];
};

export type InteractiveHostBridge = {
	capture(sessionManager: SessionManager): Promise<InteractiveCapture>;
};

const BRIDGE_REGISTRY_KEY = "__piAgentCoordinationInteractiveHostBridge";
const globalBridgeRegistry = globalThis as typeof globalThis & {
	[BRIDGE_REGISTRY_KEY]?: WeakMap<object, BridgeState>;
};
// Pi may re-evaluate extension modules during resource reload. Process-global
// ownership prevents a second evaluation from stacking private host patches.
const bridgeStates = (globalBridgeRegistry[BRIDGE_REGISTRY_KEY] ??= new WeakMap());

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
		capture(sessionManager) {
			const capture = state.capturesBySessionManager.get(sessionManager);
			if (capture) return Promise.resolve(capture);
			return new Promise((resolve, reject) =>
				state.waiters.push({ sessionManager, resolve, reject })
			);
		},
	};
}

function installRuntimeCapture(host: HostModule): BridgeState {
	const state: BridgeState = {
		capturesBySessionManager: new WeakMap(),
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
			const capture = {
				runtime,
				projectionHost: createPiNativeProjectionHost({
					ownerRuntime: runtime,
					ownerInteractiveMode: this,
				}),
			};
			// TUI binding is Pi's first mode-specific seam. The WeakMap association
			// cannot retain a failed or disposed Owner session by itself.
			state.capturesBySessionManager.set(sessionManager, capture);
			for (const waiter of [...state.waiters]) {
				if (waiter.sessionManager !== sessionManager) continue;
				state.waiters.splice(state.waiters.indexOf(waiter), 1);
				waiter.resolve(capture);
			}
			if (!hasInstalledExtensionBindings(runtime.session)) {
				await originalBindCurrentSessionExtensions.call(this);
				requestFullInteractiveRender(this);
				return;
			}
			await refreshNativeExtensionBindings(runtime.session, () =>
				originalBindCurrentSessionExtensions.call(this),
			);
			requestFullInteractiveRender(this);
		};
	interactivePrototype.bindCurrentSessionExtensions =
		captureValidatedInteractiveRuntime;

	return state;
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
