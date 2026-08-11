import { SessionManager } from "@earendil-works/pi-coding-agent";
import { writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { resolveCommittedAgentRuntimeBlueprint } from "../protocol/agent-runtime-blueprint.ts";
import { validateColdChildIdentity } from "../protocol/child-identity.ts";
import { validateColdModeratorInput } from "../protocol/moderator-input.ts";
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
		return inspectSessionManager(SessionManager.open(this.#sessionFile));
	}
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
	const blueprint = resolveCommittedAgentRuntimeBlueprint({
		sessionId: sessionManager.getSessionId(),
		entries,
	});
	const coldIdentityOptions = {
		sessionId: sessionManager.getSessionId(),
		sessionCwd: blueprint.configuration.cwd,
		entries,
	};
	if (blueprint.role === "ordinary") {
		validateColdChildIdentity(coldIdentityOptions);
	} else {
		validateColdModeratorInput(coldIdentityOptions);
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
