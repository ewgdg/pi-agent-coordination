import type {
	SessionContext,
	SessionEntry,
	SessionHeader,
} from "@earendil-works/pi-coding-agent";

/** One coherent, read-only view of an Agent's durable Pi transcript evidence. */
export type TranscriptInspection = Readonly<{
	sessionId: string;
	transcriptPath: string | null;
	header: SessionHeader | null;
	entries: readonly SessionEntry[];
	activeBranch: readonly SessionEntry[];
	context: Readonly<SessionContext>;
}>;

/** Storage adapter that obtains a new transcript view at the time of each read. */
export interface TranscriptReader {
	read(): TranscriptInspection;
}

/**
 * Agent-owned transcript evidence boundary.
 *
 * This object deliberately keeps no snapshot cache. A file-backed reader can
 * reopen the authoritative transcript on every inspection while a Runtime in
 * another process is appending to it.
 */
export class AgentTranscript {
	readonly #reader: TranscriptReader;

	constructor(reader: TranscriptReader) {
		this.#reader = reader;
	}

	inspect(): TranscriptInspection {
		return this.#reader.read();
	}
}
