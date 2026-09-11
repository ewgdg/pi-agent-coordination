import { createHash } from "node:crypto";
import type { AgentTranscript } from "../transcript/agent-transcript.ts";
import { coordinationEntries } from "../transcript/retained-transcript.ts";
import { toolCallPointerKey } from "../protocol/identities.ts";
import {
	MODERATOR_REPORT_CUSTOM_TYPE,
	MODERATOR_REPORT_READ_STATE_CUSTOM_TYPE,
	validateReportToUserInput,
	type ModeratorReport,
	type ModeratorReportSource,
	type Reporter,
	type ReportHistoryItem,
	type ReportToUserInput,
} from "../protocol/moderator-report.ts";

export class ModeratorReportStore {
	readonly #transcript: AgentTranscript;
	readonly #append: (customType: string, data: unknown) => string;

	constructor(options: {
		transcript: AgentTranscript;
		appendCustomEntry(customType: string, data: unknown): string;
	}) {
		this.#transcript = options.transcript;
		this.#append = options.appendCustomEntry;
	}

	publish(input: ReportToUserInput, reporter: Reporter, source: ModeratorReportSource): ModeratorReport {
		const validated = validateReportToUserInput(input);
		validateProvenance(reporter, source);
		const reportId = createHash("sha256").update(JSON.stringify([MODERATOR_REPORT_CUSTOM_TYPE, toolCallPointerKey(source)])).digest("base64url");
		const existing = this.history().find((item) => item.report.reportId === reportId);
		// A retried source returns its original publication, never a revised report.
		if (existing) return existing.report;
		const report = freezeReport({ ...validated, reportId, createdAt: new Date().toISOString(), reporter, source });
		this.#append(MODERATOR_REPORT_CUSTOM_TYPE, report);
		return report;
	}

	history(): readonly ReportHistoryItem[] {
		const transcript = this.#transcript.inspect();
		const reports = new Map<string, ModeratorReport>();
		const reads = new Map<string, string>();
		for (const entry of coordinationEntries(transcript, transcript.sessionId, "coordination")) {
			if (entry.type !== "custom") continue;
			if (entry.customType === MODERATOR_REPORT_CUSTOM_TYPE) {
				const report = freezeReport(entry.data as ModeratorReport);
				if (reports.has(report.reportId)) throw new Error(`Duplicate Moderator report ${report.reportId}`);
				reports.set(report.reportId, report);
			} else if (entry.customType === MODERATOR_REPORT_READ_STATE_CUSTOM_TYPE) {
				const read = entry.data as { reportId: string; readAt: string | null };
				if (!read || !reports.has(read.reportId) || (read.readAt !== null && (typeof read.readAt !== "string" || !Number.isFinite(Date.parse(read.readAt))))) throw new Error("Invalid Moderator report read state");
				// A null timestamp restores attention; transcript order determines current state.
				if (read.readAt === null) reads.delete(read.reportId);
				else reads.set(read.reportId, read.readAt);
			}
		}
		return Object.freeze([...reports.values()].map((report) => Object.freeze({ report, ...(reads.has(report.reportId) ? { readAt: reads.get(report.reportId)! } : {}) })));
	}

	get(reportId: string): ModeratorReport {
		const item = this.history().find((item) => item.report.reportId === reportId);
		if (!item) throw new Error(`Unknown Moderator report ${reportId}`);
		return item.report;
	}

	setRead(reportId: string, read: boolean): void {
		const item = this.history().find((item) => item.report.reportId === reportId);
		if (!item) throw new Error(`Unknown Moderator report ${reportId}`);
		if ((item.readAt !== undefined) === read) return;
		this.#append(MODERATOR_REPORT_READ_STATE_CUSTOM_TYPE, Object.freeze({ reportId, readAt: read ? new Date().toISOString() : null }));
	}
}

function freezeReport(report: ModeratorReport): ModeratorReport {
	const input = validateReportToUserInput(report);
	validateProvenance(report.reporter, report.source);
	if (!report.reportId || !Number.isFinite(Date.parse(report.createdAt))) throw new Error("Invalid Moderator report identity or timestamp");
	// Detach nested values from callers and transcript adapters before freezing.
	return Object.freeze({ ...input, reportId: report.reportId, createdAt: report.createdAt,
		reporter: Object.freeze({ ...report.reporter }), source: Object.freeze({ ...report.source }),
	});
}

function validateProvenance(reporter: Reporter, source: ModeratorReportSource): void {
	for (const [field, value] of Object.entries({
		reporterAgentId: reporter?.agentId, reporterLabel: reporter?.label,
		sourceAgentId: source?.agentId, entryId: source?.entryId,
		toolCallId: source?.toolCallId, transcriptPath: source?.transcriptPath,
	})) {
		if (typeof value !== "string" || !value.trim()) throw new Error(`Report ${field} must be nonblank text`);
	}
	if (reporter.agentId !== source.agentId) throw new Error("Report reporter must match source Agent");
}
