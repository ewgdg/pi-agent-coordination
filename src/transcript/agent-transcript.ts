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
	refresh?(): Promise<TranscriptInspection>;
	diagnostics?(): TranscriptDiagnostics;
	snapshot?(): TranscriptInspection | undefined;
}

export type TranscriptDiagnostics = Readonly<{
	localEnumerations: number;
	localEntriesEnumerated: number;
	bytesRead: number;
	entriesParsed: number;
	entriesConsumed: number;
	reconstructions: number;
	retainedEntries: number;
	branchBuilds: number;
	contextBuilds: number;
}>;

/**
 * Agent-owned transcript evidence boundary.
 *
 * Readers own disposable projections. Notifications never establish commitment;
 * each read checks the authority's physical cursor for missed appends.
 */
export class AgentTranscript {
	readonly #reader: TranscriptReader;
	#observation: TranscriptInspection | undefined;

	constructor(reader: TranscriptReader) {
		this.#reader = reader;
	}

	inspect(): TranscriptInspection {
		return this.#observation ?? this.#reader.read();
	}

	/** Share one physical observation within a synchronous consumer operation. */
	withObservation<T>(work: () => T, inspection: TranscriptInspection = this.inspect()): T {
		const previous = this.#observation;
		this.#observation = inspection;
		try { return work(); } finally { this.#observation = previous; }
	}

	refresh(): Promise<TranscriptInspection> {
		return this.#reader.refresh?.() ?? Promise.resolve(this.inspect());
	}

	diagnostics(): TranscriptDiagnostics | undefined {
		return this.#reader.diagnostics?.();
	}

	/** Rendering can reuse the last coherent observation while catch-up yields. */
	snapshot(): TranscriptInspection | undefined {
		return this.#reader.snapshot?.();
	}
}
