import {
	SessionManager,
	buildSessionContext,
	migrateSessionEntries,
	parseSessionEntries,
	type FileEntry,
	type SessionEntry,
	type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { validateColdChildIdentity } from "../protocol/child-identity.ts";
import {
	MODERATOR_INPUT_CUSTOM_TYPE,
	validateColdModeratorInput,
} from "../protocol/moderator-input.ts";
import {
	AgentTranscript,
	type TranscriptInspection,
	type TranscriptReader,
} from "../transcript/agent-transcript.ts";

/** Local Pi adapter used while this process owns the SessionManager. */
class SessionManagerTranscriptReader implements TranscriptReader {
	readonly #sessionManager: SessionManager;

	constructor(sessionManager: SessionManager) {
		this.#sessionManager = sessionManager;
	}

	read(): TranscriptInspection {
		return inspectSessionManager(this.#sessionManager);
	}
}

/** Reopens the durable JSONL for every read while another process may own writes. */
class SessionFileTranscriptReader implements TranscriptReader {
	readonly #sessionFile: string;

	constructor(sessionFile: string) {
		if (!isAbsolute(sessionFile) || sessionFile.includes("\0")) {
			throw new Error("invalid_transcript_path: session file must be absolute");
		}
		this.#sessionFile = sessionFile;
	}

	read(): TranscriptInspection {
		return inspectSessionFile(this.#sessionFile);
	}
}

function inspectSessionFile(sessionFile: string): TranscriptInspection {
	// Pi's SessionManager.open() may rewrite legacy sessions or materialize an
	// empty file. Parse and migrate only this in-memory clone so inspection is
	// byte-for-byte read-only at the durable evidence seam.
	const fileEntries = structuredClone(
		parseSessionEntries(readFileSync(sessionFile, "utf8")),
	) as FileEntry[];
	migrateSessionEntries(fileEntries);
	const header = fileEntries.find((entry): entry is SessionHeader => entry.type === "session")
		?? null;
	const entries = fileEntries.filter((entry): entry is SessionEntry => entry.type !== "session");
	const leafId = entries.at(-1)?.id ?? null;
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	return {
		sessionId: header?.id ?? "",
		transcriptPath: sessionFile,
		header,
		entries,
		activeBranch: activeBranch(entries, leafId, byId),
		context: buildSessionContext(entries, leafId, byId),
	};
}

function activeBranch(
	entries: readonly SessionEntry[],
	leafId: string | null,
	byId: ReadonlyMap<string, SessionEntry>,
): SessionEntry[] {
	const branch: SessionEntry[] = [];
	let currentId = leafId;
	const visited = new Set<string>();
	while (currentId) {
		if (visited.has(currentId)) break;
		visited.add(currentId);
		const entry = byId.get(currentId);
		if (!entry) break;
		branch.push(entry);
		currentId = entry.parentId;
	}
	branch.reverse();
	return branch;
}

export function transcriptFromSessionManager(
	sessionManager: SessionManager,
): AgentTranscript {
	return new AgentTranscript(new SessionManagerTranscriptReader(sessionManager));
}

export function transcriptFromSessionFile(sessionFile: string): AgentTranscript {
	return new AgentTranscript(new SessionFileTranscriptReader(sessionFile));
}

/** Persists pre-launch evidence before a fresh Pi process becomes transcript authority. */
export async function materializeNewAgentTranscript(
	sessionManager: SessionManager,
): Promise<string> {
	const sessionFile = sessionManager.getSessionFile();
	const header = sessionManager.getHeader();
	if (!sessionFile || !header) {
		throw new Error("transcript_materialization_failed: persisted session header is unavailable");
	}
	const entries = sessionManager.getEntries();
	if (entries.length === 0) {
		throw new Error("transcript_materialization_failed: Agent Identity evidence is unavailable");
	}
	if (header.id !== sessionManager.getSessionId()) {
		throw new Error(
			"transcript_materialization_failed: header does not match the Agent session",
		);
	}
	const coldIdentityOptions = {
		sessionId: sessionManager.getSessionId(),
		entries,
	};
	if (
		entries[0]?.type === "custom_message" &&
		entries[0].customType === MODERATOR_INPUT_CUSTOM_TYPE
	) {
		validateColdModeratorInput(coldIdentityOptions);
	} else {
		validateColdChildIdentity(coldIdentityOptions);
	}
	const body = `${[header, ...entries]
		.map((entry) => JSON.stringify(entry))
		.join("\n")}\n`;
	try {
		await writeFile(sessionFile, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
	} catch (error) {
		if (hasCode(error, "EEXIST")) {
			throw new Error("transcript_materialization_failed: transcript already exists", {
				cause: error,
			});
		}
		throw error;
	}
	return sessionFile;
}

function inspectSessionManager(sessionManager: SessionManager): TranscriptInspection {
	return {
		sessionId: sessionManager.getSessionId(),
		transcriptPath: sessionManager.getSessionFile() ?? null,
		header: sessionManager.getHeader(),
		entries: sessionManager.getEntries(),
		activeBranch: sessionManager.getBranch(),
		context: sessionManager.buildSessionContext(),
	};
}

function hasCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error
		&& (error as NodeJS.ErrnoException).code === code;
}
