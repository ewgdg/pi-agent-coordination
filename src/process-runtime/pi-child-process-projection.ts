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
 * Input-idle covers only the synchronous node-pty dispatch critical section;
 * child editor and prompt preflight lifecycle require future Bridge events.
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

	return Object.freeze({
		presentation: terminal.presentation,
		resize: terminal.resize,
		dispatchInput(data) {
			processingInput = true;
			inputIdle = new Promise<void>((resolve) => {
				settleInputIdle = resolve;
			});
			try {
				terminal.dispatchInput(data);
			} finally {
				processingInput = false;
				settleInputIdle?.();
				settleInputIdle = undefined;
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
		dispose: () => terminal.dispose(),
	});
}
