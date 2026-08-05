import type {
	AgentSessionServices,
} from "@earendil-works/pi-coding-agent";

import type { ChildAgentIdentity } from "../protocol/child-identity.ts";
import type { OwnerIdentity } from "../protocol/owner-identity.ts";
import {
	type AgentRunState,
	InProcessAgentHost,
} from "../runtime/in-process-agent-host.ts";
import type { EffectiveAgentRunConfiguration } from "../templates/agent-configuration.ts";

export type OrdinaryAgentIdentity = OwnerIdentity | ChildAgentIdentity;

export type AgentRecord = {
	identity: OrdinaryAgentIdentity;
	services?: AgentSessionServices;
	effectiveConfiguration?: EffectiveAgentRunConfiguration;
	host: InProcessAgentHost;
	children: string[];
};

export type AgentStatus = Readonly<{
	agentId: string;
	workflowId: string;
	label: string;
	description?: string;
	directSpawnerAgentId: string | null;
	primaryEvidence: Readonly<{
		transcriptPath: string | null;
		inspectedThrough: Readonly<{
			agentId: string;
			entryId: string;
		}>;
	}>;
	run: AgentRunState;
}>;

export class EvidenceUnavailableError extends Error {
	constructor(message: string) {
		super(`evidence_unavailable: ${message}`);
		this.name = "EvidenceUnavailableError";
	}
}

export function statusOf(record: AgentRecord): AgentStatus {
	const configuration = record.identity.configuration;
	const run: AgentRunState = record.host.observe();
	const transcriptTail = record.host.sessionManager.getEntries().at(-1);
	if (!transcriptTail) {
		throw new Error(
			`invariant_violation: Agent ${record.identity.agentId} has no transcript evidence`,
		);
	}
	return {
		agentId: record.identity.agentId,
		workflowId: record.identity.workflowId,
		label: configuration.label,
		...(!("description" in configuration) || configuration.description === undefined
			? {}
			: { description: configuration.description }),
		directSpawnerAgentId: record.identity.directSpawnerAgentId,
		primaryEvidence: {
			transcriptPath: record.host.sessionManager.getSessionFile() ?? null,
			inspectedThrough: {
				agentId: record.identity.agentId,
				entryId: transcriptTail.id,
			},
		},
		run,
	};
}

export function requireLiveSession(record: AgentRecord) {
	return record.host.requireLiveSession();
}

export function requireLiveServices(record: AgentRecord): AgentSessionServices {
	if (!record.services || !record.host.currentHandle()) {
		throw new Error(`Agent Run services are unavailable: ${record.identity.agentId}`);
	}
	return record.services;
}

export function requireAgentRecord(
	agents: ReadonlyMap<string, AgentRecord>,
	quarantinedAgentIds: ReadonlySet<string>,
	agentId: string,
): AgentRecord {
	const record = agents.get(agentId);
	if (record) return record;
	if (quarantinedAgentIds.has(agentId)) {
		throw new EvidenceUnavailableError(`Agent ${agentId} could not be verified`);
	}
	throw new Error(`unknown_identity: ${agentId}`);
}
