import { emitKeypressEvents } from "node:readline";

import { reportPassed, type ConformanceReport } from "./conformance-model.ts";
import { runPiTranscriptConformance } from "./pi-harness.ts";

const nonInteractive = process.argv.includes("--all") || !process.stdin.isTTY;

if (nonInteractive) {
	const report = await runPiTranscriptConformance();
	process.stdout.write(renderReport(report, true));
	process.exitCode = reportPassed(report) ? 0 : 1;
} else {
	await runInteractivePrototype();
}

async function runInteractivePrototype(): Promise<void> {
	let report: ConformanceReport | undefined;
	let showDetails = false;
	let running = false;
	let closed = false;
	let resolveQuit: (() => void) | undefined;
	const quit = new Promise<void>((resolve) => {
		resolveQuit = resolve;
	});

	emitKeypressEvents(process.stdin);
	process.stdin.setRawMode(true);
	process.stdin.resume();

	const render = () => {
		console.clear();
		process.stdout.write("\x1b[1mPROTOTYPE — Pi transcript conformance\x1b[0m\n");
		process.stdout.write("Can Pi 0.82.0 expose the coordination commit boundaries without a core change?\n\n");
		if (running) {
			process.stdout.write("Running deterministic SDK/extension probes…\n");
		} else if (report) {
			process.stdout.write(renderReport(report, showDetails));
		} else {
			process.stdout.write("State: not run\n");
		}
		process.stdout.write("\n\x1b[1m[r]\x1b[0m rerun  \x1b[1m[d]\x1b[0m toggle details  \x1b[1m[q]\x1b[0m quit\n");
	};

	const run = async () => {
		if (running) return;
		running = true;
		render();
		report = await runPiTranscriptConformance();
		running = false;
		if (!closed) render();
	};

	process.stdin.on("keypress", (_input, key) => {
		if ((key?.ctrl && key.name === "c") || key?.name === "q") {
			closed = true;
			process.stdin.setRawMode(false);
			process.stdin.pause();
			process.stdout.write("\n");
			resolveQuit?.();
			return;
		}
		if (key?.name === "r") void run();
		if (key?.name === "d") {
			showDetails = !showDetails;
			render();
		}
	});

	render();
	await run();
	await quit;
}

function renderReport(report: ConformanceReport, showDetails: boolean): string {
	const lines = [`Pi ${report.piVersion}`, ""];
	if (report.runtimeError) {
		lines.push("FAIL  prototype runtime", indent(report.runtimeError), "");
	}
	for (const result of report.checks) {
		lines.push(`${result.passed ? "PASS" : "FAIL"}  ${result.name}`);
		if (showDetails || !result.passed) lines.push(`      ${result.evidence}`);
	}
	lines.push("", "Core seam verdict:", indent(report.coreChangeVerdict));
	if (showDetails && report.snapshots.length > 0) {
		lines.push("", "Hook timeline:");
		for (const snapshot of report.snapshots) {
			lines.push(
				`- ${snapshot.hook}${snapshot.eventSubject ? ` (${snapshot.eventSubject})` : ""}`,
				`  branch: ${snapshot.branch.join(" → ") || "<empty>"}`,
				`  file:   ${snapshot.file.join(" → ") || "<not materialized>"}`,
			);
		}
	}
	return `${lines.join("\n")}\n`;
}

function indent(value: string): string {
	return value.split("\n").map((line) => `  ${line}`).join("\n");
}
