export interface ConformanceCheck {
	name: string;
	passed: boolean;
	evidence: string;
}

export interface HookSnapshot {
	hook: string;
	eventSubject?: string;
	branch: string[];
	file: string[];
	toolExecutionStarts: string[];
}

export interface ConformanceReport {
	piVersion: string;
	checks: ConformanceCheck[];
	snapshots: HookSnapshot[];
	coreChangeVerdict: string;
	scratchSessionFile?: string;
	runtimeError?: string;
}

export function check(name: string, passed: boolean, evidence: string): ConformanceCheck {
	return { name, passed, evidence };
}

export function reportPassed(report: ConformanceReport): boolean {
	return report.runtimeError === undefined && report.checks.every((result) => result.passed);
}
