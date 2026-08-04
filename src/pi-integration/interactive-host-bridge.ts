import type {
	AgentSessionRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

import {
	assertHostModuleShape,
	assertInteractiveModeInstanceShape,
	assertRuntimeInstanceShape,
} from "./host-shape.ts";

type RuntimeConstructor = {
	prototype: {
		setRebindSession(rebindSession?: (session: unknown) => Promise<void>): void;
	};
};

type HostModule = {
	VERSION?: unknown;
	AgentSessionRuntime: RuntimeConstructor;
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
	runtimes: Set<AgentSessionRuntime>;
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
			for (const runtime of state.runtimes) {
				if (ownsSessionManager(runtime, sessionManager)) return Promise.resolve(runtime);
			}
			return new Promise((resolve) => state.waiters.push({ sessionManager, resolve }));
		},
	};
}

function installRuntimeCapture(host: HostModule): BridgeState {
	const state: BridgeState = { runtimes: new Set(), waiters: [] };
	const runtimePrototype = host.AgentSessionRuntime.prototype;
	const interactivePrototype = host.InteractiveMode.prototype;
	const originalSetRebindSession = runtimePrototype.setRebindSession;
	const originalBindCurrentSessionExtensions =
		interactivePrototype.bindCurrentSessionExtensions;

	runtimePrototype.setRebindSession = function captureInteractiveRuntime(
		rebindSession?: (session: unknown) => Promise<void>,
	): void {
		originalSetRebindSession.call(this, rebindSession);
		if (!rebindSession) return;

		assertRuntimeInstanceShape(this, host.VERSION);
		const runtime = this as unknown as AgentSessionRuntime;
		state.runtimes.add(runtime);
		for (const waiter of [...state.waiters]) {
			if (!ownsSessionManager(runtime, waiter.sessionManager)) continue;
			state.waiters.splice(state.waiters.indexOf(waiter), 1);
			waiter.resolve(runtime);
		}
	};
	try {
		interactivePrototype.bindCurrentSessionExtensions =
			async function validateInteractiveHostBeforeBinding(): Promise<void> {
				assertInteractiveModeInstanceShape(this, host.VERSION);
				await originalBindCurrentSessionExtensions.call(this);
			};
	} catch (error) {
		runtimePrototype.setRebindSession = originalSetRebindSession;
		throw error;
	}

	return state;
}

function ownsSessionManager(runtime: AgentSessionRuntime, sessionManager: SessionManager): boolean {
	return (
		runtime.session.sessionManager === sessionManager ||
		runtime.session.sessionManager.getSessionId() === sessionManager.getSessionId()
	);
}
