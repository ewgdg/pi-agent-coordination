import type { TranscriptInspection } from "../transcript/agent-transcript.ts";
import {
	currentCoordinationScope,
	resolveCommittedToolCall,
	sameToolCallPointer,
} from "../protocol/identities.ts";
import { inspectMessageDeliveries } from "../protocol/message-delivery.ts";
import {
	EvidenceUnavailableError,
	type AgentRecord,
} from "./agent-record.ts";

export type AgentMessageTargetCandidate = Readonly<{
	agentId: string;
	label: string;
}>;

/** Resolve the public target selector without ever choosing an arbitrary match. */
export function resolveAgentMessageTarget<
	Candidate extends AgentMessageTargetCandidate,
>(
	identityCandidates: Iterable<Candidate>,
	labelCandidates: Iterable<Candidate>,
	targetAgent: string,
): Candidate {
	const selector = targetAgent.trim();
	if (!selector) {
		throw new Error("invalid_input: Agent Message targetAgent must not be blank");
	}
	const identity = resolveIdentityCandidate([...identityCandidates], selector);
	if (identity) return identity;
	const labelMatches = [...labelCandidates].filter(({ label }) => label === selector);
	if (labelMatches.length === 1) return labelMatches[0]!;
	if (labelMatches.length > 1) {
		throw new Error(
			`ambiguous_target: Agent label ${selector} matches ${labelMatches.length} addressable Agents`,
		);
	}
	throw new Error(`unknown_identity: Agent Message target ${selector}`);
}

function resolveIdentityCandidate<Candidate extends AgentMessageTargetCandidate>(
	candidates: readonly Candidate[],
	selector: string,
): Candidate | undefined {
	const exactIdentity = candidates.find(({ agentId }) => agentId === selector);
	if (exactIdentity) return exactIdentity;
	const suffixMatches = candidates.filter(({ agentId }) => agentId.endsWith(selector));
	if (suffixMatches.length === 1) return suffixMatches[0]!;
	if (suffixMatches.length > 1) {
		throw new Error(
			`ambiguous_target: Agent ID suffix ${selector} matches ${suffixMatches.length} Agents`,
		);
	}
	return undefined;
}

export function resolveCommittedAgentMessageTargetId(options: {
	agents: ReadonlyMap<string, AgentRecord>;
	quarantinedWorkflowAgentIds: ReadonlySet<string>;
	authorAgentId: string;
	authorTranscript: TranscriptInspection;
	toolCallId: string;
	targetAgent: string;
}): string {
	const {
		agents,
		quarantinedWorkflowAgentIds,
		authorAgentId,
		authorTranscript,
		toolCallId,
		targetAgent,
	} = options;
	const persistedTargetAgentId = inspectPersistedTargetAgentId({
		authorAgentId,
		transcript: authorTranscript,
		toolCallId,
	});
	if (persistedTargetAgentId !== undefined) {
		const target = agents.get(persistedTargetAgentId);
		if (target) {
			validateTargetMatchesSelector(target, targetAgent);
			return persistedTargetAgentId;
		}
		if (quarantinedWorkflowAgentIds.has(persistedTargetAgentId)) {
			// The binding remains canonical when cold recovery quarantines the target;
			// availability is a separate decision at the operation boundary.
			return persistedTargetAgentId;
		}
		throw new Error(
			`invariant_violation: Agent Message author result names unknown target ${persistedTargetAgentId}`,
		);
	}

	const selector = targetAgent.trim();
	if (!selector) {
		throw new Error("invalid_input: Agent Message targetAgent must not be blank");
	}

	// Delivery is canonical target-binding evidence when Pi lost the author result.
	// It must win before a later roster change can reinterpret the selector.
	const { source } = resolveCommittedToolCall({
		agentId: authorAgentId,
		transcript: authorTranscript,
		toolCallId,
		toolName: "agent_message",
	});
	const deliveredTargets = [...agents.values()].filter((record) =>
		inspectMessageDeliveries({
			recipientAgentId: record.identity.agentId,
			transcript: record.transcript.inspect(),
		}).some((delivery) => sameToolCallPointer(delivery.source, source))
	);
	if (deliveredTargets.length > 1) {
		throw new Error(
			`invariant_violation: Agent Message ${toolCallId} has Deliveries to multiple Agents`,
		);
	}
	if (deliveredTargets[0]) {
		validateTargetMatchesSelector(deliveredTargets[0], targetAgent);
		return deliveredTargets[0].identity.agentId;
	}

	const knownCandidates = [...agents.values()].map((record) => ({
		agentId: record.identity.agentId,
		label: record.identity.metadata.label,
	}));
	const identityCandidates = [
		...knownCandidates,
		...[...quarantinedWorkflowAgentIds]
			.filter((agentId) => !agents.has(agentId))
			.map((agentId) => ({ agentId, label: "" })),
	];
	const identity = resolveIdentityCandidate(identityCandidates, selector);
	if (identity) return identity.agentId;

	// A quarantined Workflow candidate has unavailable label metadata, so an
	// unbound label cannot be proven unique even when one verified label matches.
	if (quarantinedWorkflowAgentIds.size > 0) {
		throw new EvidenceUnavailableError(
			`Agent Message target ${selector} depends on quarantined Agent proof`,
		);
	}
	const labelCandidateIds = labelCandidateAgentIds(agents, authorAgentId);
	return resolveAgentMessageTarget(
		[],
		knownCandidates.filter(({ agentId }) => labelCandidateIds.has(agentId)),
		targetAgent,
	).agentId;
}

function labelCandidateAgentIds(
	agents: ReadonlyMap<string, AgentRecord>,
	authorAgentId: string,
): ReadonlySet<string> {
	const author = agents.get(authorAgentId);
	if (!author) throw new Error(`unknown_identity: ${authorAgentId}`);
	if (!("spawnSource" in author.identity)) return new Set(agents.keys());
	return new Set([
		author.identity.agentId,
		author.identity.directSpawnerAgentId,
		...author.children,
	]);
}

function validateTargetMatchesSelector(
	target: AgentRecord,
	targetAgent: string,
): void {
	const selector = targetAgent.trim();
	if (
		target.identity.agentId !== selector &&
		target.identity.metadata.label !== selector &&
		!target.identity.agentId.endsWith(selector)
	) {
		throw new Error(
			"invariant_violation: Agent Message resolved target does not match its selector",
		);
	}
}

function inspectPersistedTargetAgentId(options: {
	authorAgentId: string;
	transcript: TranscriptInspection;
	toolCallId: string;
}): string | undefined {
	const results = currentCoordinationScope(
		options.transcript,
		options.authorAgentId,
	).filter(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolName === "agent_message" &&
			entry.message.toolCallId === options.toolCallId,
	);
	if (results.length > 1) {
		throw new Error(
			`invariant_violation: Agent Message ${options.toolCallId} has multiple author results`,
		);
	}
	const result = results[0];
	if (
		!result ||
		result.type !== "message" ||
		result.message.role !== "toolResult" ||
		result.message.isError ||
		typeof result.message.details !== "object" ||
		result.message.details === null ||
		!("targetAgentId" in result.message.details)
	) return undefined;
	const targetAgentId = result.message.details.targetAgentId;
	if (typeof targetAgentId !== "string" || targetAgentId.length === 0) {
		throw new Error(
			"invariant_violation: Agent Message author result has an invalid targetAgentId",
		);
	}
	return targetAgentId;
}
