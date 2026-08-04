import type {
	AgentSessionRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

import {
	assertHostModuleShape,
	assertInteractiveModeInstanceShape,
	assertRuntimeInstanceShape,
} from "./host-shape.ts";

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
};

type BridgeState = {
	runtimesBySessionManager: WeakMap<SessionManager, WeakRef<AgentSessionRuntime>>;
	waiters: RuntimeWaiter[];
};

export type InteractiveHostBridge = {
	captureRuntime(sessionManager: SessionManager): Promise<AgentSessionRuntime>;
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
	let state = bridgeStates.get(host);
	if (!state) {
		state = installRuntimeCapture(host);
		bridgeStates.set(host, state);
	}

	return {
		captureRuntime(sessionManager) {
			const runtime = state.runtimesBySessionManager.get(sessionManager)?.deref();
			if (runtime) return Promise.resolve(runtime);
			return new Promise((resolve) => state.waiters.push({ sessionManager, resolve }));
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

	interactivePrototype.bindCurrentSessionExtensions =
		async function captureValidatedInteractiveRuntime(): Promise<void> {
			assertInteractiveModeInstanceShape(this, host.VERSION);
			const runtime = (this as unknown as { runtimeHost: unknown }).runtimeHost;
			assertRuntimeInstanceShape(runtime, host.VERSION);
			const sessionManager = runtime.session.sessionManager;
			// TUI binding is Pi's first mode-specific seam. Keep this association weak
			// so failed startup never turns runtime discovery into host retention.
			state.runtimesBySessionManager.set(sessionManager, new WeakRef(runtime));
			for (const waiter of [...state.waiters]) {
				if (waiter.sessionManager !== sessionManager) continue;
				state.waiters.splice(state.waiters.indexOf(waiter), 1);
				waiter.resolve(runtime);
			}
			await originalBindCurrentSessionExtensions.call(this);
		};

	return state;
}
