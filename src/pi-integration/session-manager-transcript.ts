import type { SessionManager } from "@earendil-works/pi-coding-agent";

import {
	AgentTranscript,
	type TranscriptReader,
} from "../transcript/agent-transcript.ts";

/** Local Pi adapter used while this process owns the SessionManager. */
class SessionManagerTranscriptReader implements TranscriptReader {
	readonly #sessionManager: SessionManager;

	constructor(sessionManager: SessionManager) {
		this.#sessionManager = sessionManager;
	}

	read() {
		return {
			sessionId: this.#sessionManager.getSessionId(),
			transcriptPath: this.#sessionManager.getSessionFile() ?? null,
			header: this.#sessionManager.getHeader(),
			entries: this.#sessionManager.getEntries(),
			activeBranch: this.#sessionManager.getBranch(),
			context: this.#sessionManager.buildSessionContext(),
		};
	}
}

export function transcriptFromSessionManager(
	sessionManager: SessionManager,
): AgentTranscript {
	return new AgentTranscript(new SessionManagerTranscriptReader(sessionManager));
}
