import type {
	AgentSession,
	AgentSessionRuntime,
	AgentSessionRuntimeDiagnostic,
	AgentSessionServices,
} from "@earendil-works/pi-coding-agent";

export type HumanSessionSelection = Readonly<{
	selectedAgentId(): string;
	activate(slot: Readonly<{
		agentId: string;
		session: AgentSession;
		services: AgentSessionServices;
		diagnostics: readonly AgentSessionRuntimeDiagnostic[];
	}>): Promise<void>;
}>;

type MutableRuntimeState = {
	_session: AgentSession;
	_services: AgentSessionServices;
	_diagnostics: AgentSessionRuntimeDiagnostic[];
	beforeSessionInvalidate?: () => void;
	rebindSession?: (session: AgentSession) => Promise<void>;
};

export function bindHumanSessionSelection(
	runtime: AgentSessionRuntime,
	ownerAgentId: string,
): HumanSessionSelection {
	const mutableRuntime = runtime as unknown as MutableRuntimeState;
	let selectedAgentId = ownerAgentId;
	return {
		selectedAgentId: () => selectedAgentId,
		async activate(slot) {
			if (slot.agentId === selectedAgentId) return;
			const rebindSession = mutableRuntime.rebindSession;
			if (!rebindSession) {
				throw new Error("Pi InteractiveMode has not registered its session rebind callback");
			}
			// Pi normally performs this synchronous teardown immediately before session
			// replacement. Retained Agent Runs need the same UI boundary without disposal.
			mutableRuntime.beforeSessionInvalidate?.();
			mutableRuntime._session = slot.session;
			mutableRuntime._services = slot.services;
			mutableRuntime._diagnostics = [...slot.diagnostics];
			await rebindSession(slot.session);
			selectedAgentId = slot.agentId;
		},
	};
}
