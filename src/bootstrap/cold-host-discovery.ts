import {
	CURRENT_SESSION_VERSION,
	SessionManager,
	type SessionEntry,
	type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { resolveOrdinaryAgentMetadata } from "../protocol/agent-metadata.ts";
import {
	type AgentSpawnInput,
	validateAgentSpawnInput,
} from "../protocol/agent-spawn-input.ts";
import {
	resolveCommittedAgentRuntimeBlueprint,
	type AgentRuntimeBlueprint,
} from "../protocol/agent-runtime-blueprint.ts";
import {
	validateColdChildIdentity,
	type ChildAgentIdentity,
} from "../protocol/child-identity.ts";
import {
	MODERATOR_INPUT_CUSTOM_TYPE,
	validateColdModeratorInput,
	type ModeratorIdentity,
} from "../protocol/moderator-input.ts";
import {
	resolveCommittedSpawnSource,
	sameToolCallPointer,
	toolCallPointerKey,
} from "../protocol/identities.ts";
import type { OwnerIdentity } from "../protocol/owner-identity.ts";
import {
	transcriptFromSessionFile,
	transcriptFromSessionManager,
} from "../pi-integration/session-manager-transcript.ts";
import { workflowSessionDirectory } from "../runtime/workflow-session-directory.ts";

export type RecoveredOrdinaryAgent = Readonly<{
	role: "ordinary";
	identity: ChildAgentIdentity;
	blueprint: AgentRuntimeBlueprint;
	sessionPath: string;
}>;

export type RecoveredModeratorAgent = Readonly<{
	role: "moderator";
	identity: ModeratorIdentity;
	blueprint: AgentRuntimeBlueprint;
	sessionPath: string;
}>;

export type RecoveredAgent = RecoveredOrdinaryAgent | RecoveredModeratorAgent;

export type ColdWorkflowRecovery = Readonly<{
	agents: readonly RecoveredAgent[];
	transcriptPathByAgentId: ReadonlyMap<string, string>;
	agentIdBySpawnSource: ReadonlyMap<string, string>;
	quarantinedAgentIds: ReadonlySet<string>;
	quarantinedCandidateCount: number;
}>;

type CandidateBase = {
	path: string;
	entries: readonly SessionEntry[];
	blueprint: AgentRuntimeBlueprint;
	invalid: boolean;
};

type OrdinaryCandidate = CandidateBase & {
	role: "ordinary";
	identity: ChildAgentIdentity;
	spawnInput?: AgentSpawnInput;
	spawnOrder?: Readonly<{ entry: number; part: number }>;
};

type ModeratorCandidate = CandidateBase & {
	role: "moderator";
	identity: ModeratorIdentity;
};

type Candidate = OrdinaryCandidate | ModeratorCandidate;

class CandidateError extends Error {
	readonly agentId: string | undefined;

	constructor(message: string, agentId?: string) {
		super(message);
		this.agentId = agentId;
	}
}

export async function discoverColdWorkflow(options: {
	ownerIdentity: OwnerIdentity;
	ownerSessionManager: SessionManager;
}): Promise<ColdWorkflowRecovery> {
	const { ownerIdentity, ownerSessionManager } = options;
	if (!ownerSessionManager.isPersisted() || ownerSessionManager.getSessionDir().length === 0) {
		return emptyRecovery();
	}
	const directory = workflowSessionDirectory(
		ownerSessionManager.getSessionDir(),
		ownerIdentity.workflowId,
	);
	let filenames: string[];
	try {
		filenames = (await readdir(directory)).filter((name) => name.endsWith(".jsonl"));
	} catch (error) {
		if (isMissingDirectory(error)) return emptyRecovery();
		return {
			...emptyRecovery(),
			quarantinedCandidateCount: 1,
		};
	}

	const candidates: Candidate[] = [];
	const quarantinedAgentIds = new Set<string>();
	let unreadableCandidateCount = 0;
	for (const filename of filenames) {
		try {
			candidates.push(await readCandidate(join(directory, filename)));
		} catch (error) {
			unreadableCandidateCount += 1;
			if (error instanceof CandidateError && error.agentId) {
				quarantinedAgentIds.add(error.agentId);
			}
		}
	}

	const candidatesByAgentId = groupBy(candidates, ({ identity }) => identity.agentId);
	for (const [agentId, claims] of candidatesByAgentId) {
		if (claims.length === 1) continue;
		quarantinedAgentIds.add(agentId);
		for (const claim of claims) claim.invalid = true;
	}
	const ordinaryCandidates = candidates.filter(isOrdinaryCandidate);
	const candidatesBySource = groupBy(
		ordinaryCandidates,
		({ identity }) => toolCallPointerKey(identity.spawnSource),
	);
	for (const claims of candidatesBySource.values()) {
		if (claims.length === 1) continue;
		for (const claim of claims) {
			claim.invalid = true;
			quarantinedAgentIds.add(claim.identity.agentId);
		}
	}

	const uniqueByAgentId = new Map<string, OrdinaryCandidate>();
	for (const [agentId, claims] of candidatesByAgentId) {
		const claim = claims[0];
		if (claims.length === 1 && claim?.role === "ordinary") {
			uniqueByAgentId.set(agentId, claim);
		}
	}
	for (const candidate of candidates) {
		if (candidate.identity.workflowId !== ownerIdentity.workflowId) {
			candidate.invalid = true;
			quarantinedAgentIds.add(candidate.identity.agentId);
		}
		if (candidate.role === "moderator") continue;
		const parent = candidate.identity.directSpawnerAgentId === ownerIdentity.agentId
			? {
				transcript: transcriptFromSessionManager(ownerSessionManager),
				entries: ownerSessionManager.getEntries(),
			}
			: (() => {
				const parentCandidate = uniqueByAgentId.get(
					candidate.identity.directSpawnerAgentId,
				);
				return parentCandidate
					? {
						transcript: transcriptFromSessionFile(parentCandidate.path),
						entries: parentCandidate.entries,
					}
					: undefined;
			})();
		if (!parent) {
			candidate.invalid = true;
			quarantinedAgentIds.add(candidate.identity.agentId);
			continue;
		}
		try {
			const committed = resolveCommittedSpawnSource({
				agentId: candidate.identity.directSpawnerAgentId,
				transcript: parent.transcript.inspect(),
				toolCallId: candidate.identity.spawnSource.toolCallId,
			});
			if (!sameToolCallPointer(committed.source, candidate.identity.spawnSource)) {
				throw new Error("spawn pointer entry does not match");
			}
			const input = validateAgentSpawnInput(committed.input);
			const metadata = resolveOrdinaryAgentMetadata({
				explicitLabel: input.label,
				explicitDescription: input.description,
				templateName: input.template,
			});
			const identityMetadata = {
				label: candidate.identity.configuration.label,
				...(candidate.identity.configuration.description === undefined
					? {}
					: { description: candidate.identity.configuration.description }),
			};
			if (!isDeepStrictEqual(metadata, identityMetadata)) {
				throw new Error("child metadata contradicts its spawn source");
			}
			candidate.spawnInput = input;
			candidate.spawnOrder = physicalSpawnOrder(
				parent.entries,
				committed.source.entryId,
				committed.source.toolCallId,
			);
		} catch {
			candidate.invalid = true;
			quarantinedAgentIds.add(candidate.identity.agentId);
		}
	}

	const reachesOwner = new Map<OrdinaryCandidate, boolean>();
	const visiting = new Set<OrdinaryCandidate>();
	const verifyPath = (candidate: OrdinaryCandidate): boolean => {
		const known = reachesOwner.get(candidate);
		if (known !== undefined) return known;
		if (candidate.invalid) {
			reachesOwner.set(candidate, false);
			return false;
		}
		if (visiting.has(candidate)) {
			candidate.invalid = true;
			quarantinedAgentIds.add(candidate.identity.agentId);
			reachesOwner.set(candidate, false);
			return false;
		}
		visiting.add(candidate);
		const parentId = candidate.identity.directSpawnerAgentId;
		const valid = parentId === ownerIdentity.agentId || (() => {
			const parent = uniqueByAgentId.get(parentId);
			return parent !== undefined && verifyPath(parent);
		})();
		visiting.delete(candidate);
		if (!valid) {
			candidate.invalid = true;
			quarantinedAgentIds.add(candidate.identity.agentId);
		}
		reachesOwner.set(candidate, valid);
		return valid;
	};
	for (const candidate of ordinaryCandidates) verifyPath(candidate);

	const verifiedChildren = new Map<string, OrdinaryCandidate[]>();
	for (const candidate of ordinaryCandidates) {
		if (candidate.invalid || !candidate.spawnInput || !candidate.spawnOrder) continue;
		const children = verifiedChildren.get(candidate.identity.directSpawnerAgentId) ?? [];
		children.push(candidate);
		verifiedChildren.set(candidate.identity.directSpawnerAgentId, children);
	}
	for (const children of verifiedChildren.values()) {
		children.sort(compareSpawnOrder);
	}
	const ordered: OrdinaryCandidate[] = [];
	const appendDescendants = (parentAgentId: string) => {
		for (const child of verifiedChildren.get(parentAgentId) ?? []) {
			ordered.push(child);
			appendDescendants(child.identity.agentId);
		}
	};
	appendDescendants(ownerIdentity.agentId);
	const moderators = candidates
		.filter(isModeratorCandidate)
		.filter(({ invalid }) => !invalid)
		.sort((left, right) => left.path.localeCompare(right.path));

	const transcriptPathByAgentId = new Map<string, string>();
	const agentIdBySpawnSource = new Map<string, string>();
	for (const candidate of ordered) {
		transcriptPathByAgentId.set(candidate.identity.agentId, candidate.path);
		agentIdBySpawnSource.set(
			toolCallPointerKey(candidate.identity.spawnSource),
			candidate.identity.agentId,
		);
	}
	for (const candidate of moderators) {
		transcriptPathByAgentId.set(candidate.identity.agentId, candidate.path);
	}
	return {
		agents: [
			...ordered.map((candidate) => ({
				role: "ordinary" as const,
				identity: candidate.identity,
				blueprint: candidate.blueprint,
				sessionPath: candidate.path,
			})),
			...moderators.map((candidate) => ({
				role: "moderator" as const,
				identity: candidate.identity,
				blueprint: candidate.blueprint,
				sessionPath: candidate.path,
			})),
		],
		transcriptPathByAgentId,
		agentIdBySpawnSource,
		quarantinedAgentIds,
		quarantinedCandidateCount:
			unreadableCandidateCount + candidates.filter(({ invalid }) => invalid).length,
	};
}

async function readCandidate(path: string): Promise<Candidate> {
	let bytes: Buffer;
	try {
		bytes = await readFile(path);
	} catch {
		throw new CandidateError("candidate transcript is unreadable");
	}
	if (bytes.length === 0 || bytes.at(-1) !== 0x0a) {
		throw new CandidateError("candidate transcript has an incomplete final append");
	}
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new CandidateError("candidate transcript is not valid UTF-8");
	}
	const lines = text.slice(0, -1).split("\n");
	if (lines.length < 2 || lines.some((line) => line.length === 0)) {
		throw new CandidateError("candidate transcript is empty or malformed");
	}
	let headerValue: unknown;
	try {
		headerValue = JSON.parse(lines[0]!);
	} catch {
		throw new CandidateError("candidate transcript contains malformed JSON");
	}
	const header = validateHeader(headerValue);
	let entryValues: unknown[];
	try {
		entryValues = lines.slice(1).map((line) => JSON.parse(line));
	} catch {
		throw new CandidateError(
			"candidate transcript contains malformed JSON",
			header.id,
		);
	}
	try {
		validateNativeEntries(entryValues);
	} catch (error) {
		throw new CandidateError(
			error instanceof Error ? error.message : "candidate transcript entries are invalid",
			header.id,
		);
	}
	const entries = entryValues as SessionEntry[];
	let candidateIdentity: Readonly<{
		role: "ordinary";
		identity: ChildAgentIdentity;
	}> | Readonly<{
		role: "moderator";
		identity: ModeratorIdentity;
	}>;
	try {
		if (
			entries.some((entry) => entry.type === "custom_message" &&
				entry.customType === MODERATOR_INPUT_CUSTOM_TYPE)
		) {
			candidateIdentity = {
				role: "moderator",
				identity: validateColdModeratorInput({
					sessionId: header.id,
					entries,
				}).identity,
			};
		} else {
			candidateIdentity = {
				role: "ordinary",
				identity: validateColdChildIdentity({
					sessionId: header.id,
					entries,
				}),
			};
		}
	} catch (error) {
		throw new CandidateError(
			error instanceof Error ? error.message : "candidate Identity is invalid",
			header.id,
		);
	}
	let blueprint: AgentRuntimeBlueprint;
	try {
		blueprint = resolveCommittedAgentRuntimeBlueprint({
			sessionId: header.id,
			entries,
		});
		if (blueprint.role !== candidateIdentity.role) {
			throw new Error("candidate Runtime blueprint role contradicts its Identity");
		}
		if (blueprint.agentId !== candidateIdentity.identity.agentId) {
			throw new Error("candidate Runtime blueprint agentId contradicts its Identity");
		}
		if (header.cwd !== blueprint.configuration.cwd) {
			throw new Error("candidate header cwd contradicts its Runtime blueprint");
		}
	} catch (error) {
		throw new CandidateError(
			error instanceof Error ? error.message : "candidate Runtime blueprint is invalid",
			header.id,
		);
	}
	let sessionManager: SessionManager;
	try {
		sessionManager = SessionManager.open(path);
	} catch {
		throw new CandidateError("candidate transcript cannot be opened", header.id);
	}
	if (
		!isDeepStrictEqual(sessionManager.getHeader(), header) ||
		!isDeepStrictEqual(sessionManager.getEntries(), entries)
	) {
		throw new CandidateError("candidate transcript changed during admission", header.id);
	}
	return {
		path,
		...candidateIdentity,
		entries,
		blueprint,
		invalid: false,
	};
}

function validateHeader(value: unknown): SessionHeader & { version: number } {
	if (!isRecord(value)) throw new CandidateError("candidate has no native session header");
	const expected = [
		"type",
		"version",
		"id",
		"timestamp",
		"cwd",
		...(value.parentSession === undefined ? [] : ["parentSession"]),
	].sort();
	const actual = Object.keys(value).sort();
	if (
		actual.length !== expected.length ||
		actual.some((key, index) => key !== expected[index]) ||
		value.type !== "session" ||
		value.version !== CURRENT_SESSION_VERSION ||
		!isIdentifier(value.id) ||
		!isTimestamp(value.timestamp) ||
		typeof value.cwd !== "string" ||
		!isAbsolute(value.cwd) ||
		(value.parentSession !== undefined && typeof value.parentSession !== "string")
	) {
		throw new CandidateError(
			"candidate native session header is invalid",
			isIdentifier(value.id) ? value.id : undefined,
		);
	}
	return value as unknown as SessionHeader & { version: number };
}

function validateNativeEntries(values: readonly unknown[]): void {
	const seen = new Set<string>();
	for (const value of values) {
		if (
			!isRecord(value) ||
			!isIdentifier(value.type) ||
			!isIdentifier(value.id) ||
			(value.parentId !== null && !isIdentifier(value.parentId)) ||
			!isTimestamp(value.timestamp) ||
			seen.has(value.id) ||
			(value.parentId !== null && !seen.has(value.parentId))
		) {
			throw new Error("candidate contains an invalid native session entry");
		}
		seen.add(value.id);
	}
}

function physicalSpawnOrder(
	entries: readonly SessionEntry[],
	entryId: string,
	toolCallId: string,
): Readonly<{ entry: number; part: number }> {
	const entry = entries.findIndex((candidate) => candidate.id === entryId);
	const source = entries[entry];
	if (entry < 0 || source?.type !== "message" || source.message.role !== "assistant") {
		throw new Error("canonical Agent Spawn entry is unavailable");
	}
	const part = source.message.content.findIndex(
		(candidate) => candidate.type === "toolCall" && candidate.id === toolCallId,
	);
	if (part < 0) throw new Error("canonical Agent Spawn call is unavailable");
	return { entry, part };
}

function compareSpawnOrder(left: OrdinaryCandidate, right: OrdinaryCandidate): number {
	return left.spawnOrder!.entry - right.spawnOrder!.entry ||
		left.spawnOrder!.part - right.spawnOrder!.part;
}

function isOrdinaryCandidate(candidate: Candidate): candidate is OrdinaryCandidate {
	return candidate.role === "ordinary";
}

function isModeratorCandidate(candidate: Candidate): candidate is ModeratorCandidate {
	return candidate.role === "moderator";
}

function groupBy<T>(
	values: readonly T[],
	keyOf: (value: T) => string,
): Map<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const value of values) {
		const key = keyOf(value);
		const group = groups.get(key) ?? [];
		group.push(value);
		groups.set(key, group);
	}
	return groups;
}

function emptyRecovery(): ColdWorkflowRecovery {
	return {
		agents: [],
		transcriptPathByAgentId: new Map(),
		agentIdBySpawnSource: new Map(),
		quarantinedAgentIds: new Set(),
		quarantinedCandidateCount: 0,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function isTimestamp(value: unknown): value is string {
	return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isMissingDirectory(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}
