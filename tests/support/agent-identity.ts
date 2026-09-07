import { SessionManager } from "@earendil-works/pi-coding-agent";

/** Read protocol identity rather than mistaking a Pi session UUID for an Agent address. */
export function agentIdOfSessionFile(path: string): string | undefined {
	const manager = SessionManager.open(path);
	for (const entry of manager.getEntries().toReversed()) {
		const identity = entry.type === "custom" && entry.customType === "agent-coordination.identity"
			? entry.data : entry.type === "custom_message" && entry.customType === "agent-coordination.moderator-input"
			? entry.details : undefined;
		if (identity && typeof identity === "object" && "agentId" in identity &&
			typeof identity.agentId === "string" && "sessionId" in identity &&
			identity.sessionId === manager.getSessionId()) return identity.agentId;
	}
	return undefined;
}
