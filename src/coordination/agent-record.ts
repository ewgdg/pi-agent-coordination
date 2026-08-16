import type { AgentSpawnInput } from "../protocol/agent-spawn-input.ts";
import type { ChildAgentIdentity } from "../protocol/child-identity.ts";
import type { OwnerIdentity } from "../protocol/owner-identity.ts";
import type { ModeratorIdentity } from "../protocol/moderator-input.ts";
import type {
	AgentRunState,
	AgentRuntimeHost,
} from "../runtime/agent-runtime-host.ts";
import type { EffectiveAgentRunConfiguration } from "../templates/agent-configuration.ts";
import type { AgentTemplateCatalogueSnapshot } from "../templates/agent-templates.ts";
import type { AgentTranscript } from "../transcript/agent-transcript.ts";

export type AgentIdentity = OwnerIdentity | ChildAgentIdentity | ModeratorIdentity;

export type AgentRecord = {
	identity: AgentIdentity;
	creationInput?: AgentSpawnInput;
	effectiveConfiguration?: EffectiveAgentRunConfiguration;
	agentTemplateSnapshot?: AgentTemplateCatalogueSnapshot;
	host: AgentRuntimeHost;
	transcript: AgentTranscript;
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
	const metadata = record.identity.metadata;
	const run: AgentRunState = record.host.observe();
	const transcript = record.transcript.inspect();
	const transcriptTail = transcript.entries.at(-1);
	if (!transcriptTail) {
		throw new Error(
			`invariant_violation: Agent ${record.identity.agentId} has no transcript evidence`,
		);
	}
	return {
		agentId: record.identity.agentId,
		workflowId: record.identity.workflowId,
		label: metadata.label,
		...(!("description" in metadata) || metadata.description === undefined
			? {}
			: { description: metadata.description }),
		directSpawnerAgentId: record.identity.directSpawnerAgentId,
		primaryEvidence: {
			transcriptPath: transcript.transcriptPath,
			inspectedThrough: {
				agentId: record.identity.agentId,
				entryId: transcriptTail.id,
			},
		},
		run,
	};
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
