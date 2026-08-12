import type { HostedAgentProjection } from "../runtime/hosted-agent-projection.ts";
import {
	createAdmittedPiChildProcessProjection,
	type AdmittedPiChildProjectionRuntime,
} from "./admitted-pi-child-process-projection.ts";

export type PiChildProjectionLaunch = AdmittedPiChildProjectionRuntime & Readonly<{
	ready(): Promise<unknown>;
	cancelInitialization(error: unknown): Promise<void> | undefined;
}>;

/**
 * Project one live child launch before and after exact Runtime admission.
 * Input-idle begins at PTY dispatch and ends when the child's ordered Control
 * stream admits the resulting Agent Run. Keeping the edge here lets Runtime
 * release wait without exposing PTY or Control details above the projection
 * boundary.
 */
export function createPiChildProcessProjection(
	launch: PiChildProjectionLaunch,
): HostedAgentProjection {
	const terminal = createAdmittedPiChildProcessProjection(launch);
	const readiness = launch.ready().then(() => undefined);
	void readiness.catch(() => undefined);
	let processingInput = false;
	let inputIdle = Promise.resolve();
	let settleInputIdle: (() => void) | undefined;
	let inputSubmissionPending = false;
	let acceptanceDispatch: Promise<void> | undefined;
	const finishInput = () => {
		inputSubmissionPending = false;
		processingInput = false;
		settleInputIdle?.();
		settleInputIdle = undefined;
	};
	const removeRuntimeEventHandler = launch.onEvent((event) => {
		if (!inputSubmissionPending || event.event !== "agent.start") return;
		finishInput();
	});

	return Object.freeze({
		presentation: terminal.presentation,
		physicalTerminal: terminal.physicalTerminal,
		resize: terminal.resize,
		dispatchInput(data) {
			processingInput = true;
			if (!settleInputIdle) {
				inputIdle = new Promise<void>((resolve) => {
					settleInputIdle = resolve;
				});
			}
			if (containsInputSubmission(data)) {
				inputSubmissionPending = true;
			}
			try {
				terminal.dispatchInput(data);
			} finally {
				acceptanceDispatch ??= Promise.resolve().then(() => {
					acceptanceDispatch = undefined;
					if (inputSubmissionPending) return;
					finishInput();
				});
			}
		},
		focusEditor: terminal.focusEditor,
		addChangeHandler: terminal.addChangeHandler,
		addFailureHandler: terminal.addFailureHandler,
		addExitRequestHandler: terminal.addExitRequestHandler,
		isProcessingInput: () => processingInput,
		whenInputIdle: () => inputIdle,
		ready: () => readiness,
		cancelInitialization: (error) => launch.cancelInitialization(error),
		dispose: async () => {
			removeRuntimeEventHandler();
			finishInput();
			await terminal.dispose();
		},
	});
}

function containsInputSubmission(data: string | Buffer): boolean {
	const text = typeof data === "string" ? data : data.toString("utf8");
	return text.includes("\r") || text.includes("\n");
}
