import type {
	ExtensionFactory,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

const SESSION_STARTS_KEY = "__piAgentCoordinationSessionStartProbe";
const probeGlobal = globalThis as typeof globalThis & {
	[SESSION_STARTS_KEY]?: Map<string, SessionStartEvent["reason"][]>;
};
const sessionStarts = (probeGlobal[SESSION_STARTS_KEY] ??= new Map());

export function resetSessionStartProbe(): void {
	sessionStarts.clear();
}

export function sessionStartReasons(agentId: string): readonly SessionStartEvent["reason"][] {
	return sessionStarts.get(agentId) ?? [];
}

const sessionStartProbe: ExtensionFactory = (pi) => {
	pi.on("session_start", (event, ctx) => {
		const agentId = ctx.sessionManager.getSessionId();
		const reasons = sessionStarts.get(agentId) ?? [];
		reasons.push(event.reason);
		sessionStarts.set(agentId, reasons);
	});
};

export default sessionStartProbe;
