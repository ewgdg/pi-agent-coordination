import { SessionManager } from "@earendil-works/pi-coding-agent";
import { isAbsolute } from "node:path";

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
