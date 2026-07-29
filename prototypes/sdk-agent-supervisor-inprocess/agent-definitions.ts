import type { LiveSessionKey } from "./live-session-multiplexer.ts";

export type AgentDefinition = {
	key: LiveSessionKey;
	name: string;
	description: string;
	parentKey?: LiveSessionKey;
};

export const AGENT_DEFINITIONS: readonly AgentDefinition[] = [
	{
		key: "owner",
		name: "Owner",
		description: "Workflow owner",
	},
	{
		key: "researcher",
		name: "Researcher",
		description: "Investigates focused questions",
		parentKey: "owner",
	},
	{
		key: "source-scout",
		name: "Source Scout",
		description: "Finds primary-source evidence",
		parentKey: "researcher",
	},
	{
		key: "synthesizer",
		name: "Synthesizer",
		description: "Combines research findings",
		parentKey: "researcher",
	},
	{
		key: "builder",
		name: "Builder",
		description: "Implements focused changes",
		parentKey: "owner",
	},
	{
		key: "reviewer",
		name: "Reviewer",
		description: "Reviews the Builder's result",
		parentKey: "builder",
	},
];

export function getAgentDefinition(key: LiveSessionKey): AgentDefinition {
	const definition = AGENT_DEFINITIONS.find((candidate) => candidate.key === key);
	if (!definition) throw new Error(`Unknown Agent definition: ${key}`);
	return definition;
}

export function getChildAgentDefinitions(parentKey: LiveSessionKey): AgentDefinition[] {
	return AGENT_DEFINITIONS.filter((definition) => definition.parentKey === parentKey);
}
