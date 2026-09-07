import type { ToolCallPointer } from "./identities.ts";

export type ReportToUserInput = Readonly<{
	symptom: string;
	suspectedDefect: string;
	uncertainty: string;
	recoveryActions: string;
	recoveryOutcome: string;
	evidence: readonly string[];
}>;
export type Reporter = Readonly<{ agentId: string; label: string }>;
export type ModeratorReportSource = ToolCallPointer & Readonly<{ transcriptPath: string }>;
export type ModeratorReport = ReportToUserInput & Readonly<{
	reportId: string;
	createdAt: string;
	reporter: Reporter;
	source: ModeratorReportSource;
}>;
export type ReportHistoryItem = Readonly<{ report: ModeratorReport; readAt?: string }>;

export function validateReportToUserInput(value: unknown): ReportToUserInput {
	if (typeof value !== "object" || value === null) throw new Error("Report input must be an object");
	const input = value as Record<string, unknown>;
	const text = (field: string): string => {
		const value = input[field];
		if (typeof value !== "string" || !value.trim()) throw new Error(`Report ${field} must be nonblank text`);
		return value;
	};
	if (!Array.isArray(input.evidence) || input.evidence.length === 0 || input.evidence.some((item) => typeof item !== "string" || !item.trim())) {
		throw new Error("Report evidence must contain at least one nonblank reference");
	}
	return Object.freeze({
		symptom: text("symptom"), suspectedDefect: text("suspectedDefect"),
		uncertainty: text("uncertainty"), recoveryActions: text("recoveryActions"),
		recoveryOutcome: text("recoveryOutcome"), evidence: Object.freeze([...input.evidence]),
	});
}

export function formatModeratorReport(report: ModeratorReport): string {
	return [
		`# Moderator report ${report.reportId}`,
		`Created: ${report.createdAt}`,
		`Reporter: ${report.reporter.label} (${report.reporter.agentId})`,
		`Source transcript: ${report.source.transcriptPath}`,
		`Source Agent: ${report.source.agentId}`,
		`Source entry: ${report.source.entryId}`,
		`Source tool call: ${report.source.toolCallId}`,
		"", "## Symptom", report.symptom,
		"", "## Suspected defect", report.suspectedDefect,
		"", "## Uncertainty", report.uncertainty,
		"", "## Recovery actions", report.recoveryActions,
		"", "## Recovery outcome", report.recoveryOutcome,
		"", "## Evidence", ...report.evidence.map((reference) => `- ${reference}`),
	].join("\n");
}
