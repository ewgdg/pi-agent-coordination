import type {
	AgentSession,
	AgentSessionServices,
} from "@earendil-works/pi-coding-agent";

import type { ChildAgentIdentity } from "../protocol/child-identity.ts";
import type { OwnerIdentity } from "../protocol/owner-identity.ts";
import {
	type AgentRunState,
	InProcessOwnerRunHost,
} from "../runtime/in-process-owner-run-host.ts";
import { SerialLane } from "../runtime/serial-lane.ts";

export type OrdinaryAgentIdentity = OwnerIdentity | ChildAgentIdentity;

export type AgentRecord = {
	identity: OrdinaryAgentIdentity;
	session?: AgentSession;
	services: AgentSessionServices;
	lane: SerialLane;
	host?: InProcessOwnerRunHost;
	starting: boolean;
	children: string[];
	deliveryPromise?: Promise<void>;
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
	let run: AgentRunState;
	if (record.starting) {
		run = {
			phase: "starting",
			attention: "none",
			retentionReasons: ["pending_delivery"],
		};
	} else if (record.host) {
		run = record.host.observe();
	} else {
		run = { phase: "dormant", retentionReasons: [] };
	}
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

export function requireLiveSession(record: AgentRecord): AgentSession {
	if (!record.session) throw new Error(`Agent Run is unavailable: ${record.identity.agentId}`);
	return record.session;
}
