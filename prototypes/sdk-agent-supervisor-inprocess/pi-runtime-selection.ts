import type {
	AgentSession,
	AgentSessionRuntime,
	AgentSessionRuntimeDiagnostic,
	AgentSessionServices,
} from "@earendil-works/pi-coding-agent";

import type { LiveSessionSelection, LiveSessionSlot } from "./live-session-multiplexer.ts";
import type { LiveSessionMultiplexer } from "./live-session-multiplexer.ts";

type MutableRuntimeState = {
	_session: AgentSession;
	_services: AgentSessionServices;
	_diagnostics: AgentSessionRuntimeDiagnostic[];
	_modelFallbackMessage?: string;
	beforeSessionInvalidate?: () => void;
	rebindSession?: (session: AgentSession) => Promise<void>;
};

export function bindPiRuntimeSelection(runtime: AgentSessionRuntime): LiveSessionSelection {
	const mutableRuntime = runtime as unknown as MutableRuntimeState;

	return {
		async activate(slot: LiveSessionSlot): Promise<void> {
			const rebindSession = mutableRuntime.rebindSession;
			if (!rebindSession) {
				throw new Error("Pi InteractiveMode has not registered its session rebind callback");
			}

			// Pi normally invokes this hook immediately before replacing a session. Here it
			// clears session-owned UI without invalidating the retained AgentSession.
			mutableRuntime.beforeSessionInvalidate?.();
			mutableRuntime._session = slot.session;
			mutableRuntime._services = slot.services;
			mutableRuntime._diagnostics = slot.diagnostics;
			mutableRuntime._modelFallbackMessage = slot.modelFallbackMessage;
			await rebindSession(slot.session);
		},
	};
}

export function bindPiRuntimeShutdown(
	runtime: AgentSessionRuntime,
	multiplexer: LiveSessionMultiplexer,
): void {
	const disposeSelectedSession = runtime.dispose.bind(runtime);
	let shutdown: Promise<void> | undefined;

	runtime.dispose = () => {
		shutdown ??= (async () => {
			await multiplexer.shutdownRetainedSessions();
			await disposeSelectedSession();
		})();
		return shutdown;
	};
}
