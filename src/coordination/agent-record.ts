import type {
	AgentSessionServices,
} from "@earendil-works/pi-coding-agent";

import type { ChildAgentIdentity } from "../protocol/child-identity.ts";
import type { OwnerIdentity } from "../protocol/owner-identity.ts";
import {
	type AgentRunState,
	InProcessAgentHost,
} from "../runtime/in-process-agent-host.ts";

export type OrdinaryAgentIdentity = OwnerIdentity | ChildAgentIdentity;

export type AgentRecord = {
	identity: OrdinaryAgentIdentity;
	services: AgentSessionServices;
	host: InProcessAgentHost;
	children: string[];
};

export type AgentStatus = Readonly<{
	agentId: string;
	workflowId: string;
	label: string;
	description?: string;
	directSpawnerAgentId: string | null;
	run: AgentRunState;
}>;

export function statusOf(record: AgentRecord): AgentStatus {
	const configuration = record.identity.configuration;
	const run: AgentRunState = record.host.observe();
	return {
		agentId: record.identity.agentId,
		workflowId: record.identity.workflowId,
		label: configuration.label,
		...(!("description" in configuration) || configuration.description === undefined
			? {}
			: { description: configuration.description }),
		directSpawnerAgentId: record.identity.directSpawnerAgentId,
		run,
	};
}

export function requireLiveSession(record: AgentRecord) {
	return record.host.requireLiveSession();
}
