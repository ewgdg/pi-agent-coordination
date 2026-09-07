export type AgentLabelResolver = (agentId: string) => string | undefined;

export function formatKnownAgentIdentity(agentId: string, label: string): string {
	return `${label} · ${agentId}`;
}

export function formatAgentIdentity(
	agentId: string,
	resolveLabel: AgentLabelResolver,
): string {
	const label = resolveLabel(agentId);
	return label ? formatKnownAgentIdentity(agentId, label) : agentId;
}
