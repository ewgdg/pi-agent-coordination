export const COMPACT_AGENT_IDENTITY_LENGTH = 8;

export type AgentLabelResolver = (agentId: string) => string | undefined;
export type AgentIdentityDetail = "compact" | "full";

export function compactAgentIdentity(agentId: string): string {
	return [...agentId].slice(-COMPACT_AGENT_IDENTITY_LENGTH).join("");
}

export function formatKnownAgentIdentity(
	agentId: string,
	label: string,
	detail: AgentIdentityDetail = "compact",
): string {
	return `${label} · ${detail === "full" ? agentId : compactAgentIdentity(agentId)}`;
}

export function formatAgentIdentity(
	agentId: string,
	resolveLabel: AgentLabelResolver,
	detail: AgentIdentityDetail = "compact",
): string {
	const label = resolveLabel(agentId);
	return label ? formatKnownAgentIdentity(agentId, label, detail) : agentId;
}
