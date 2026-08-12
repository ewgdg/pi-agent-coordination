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
 * Child input-idle follows explicit interactive lifecycle events. PTY dispatch
 * remains byte-transparent, so embedded newlines in bracketed paste cannot be
 * mistaken for submission. Keeping the edge here lets Runtime release wait
 * without exposing PTY or Control details above the projection boundary.
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
	let childInputActive = false;
	let dispatchSettlement: Promise<void> | undefined;
	const finishInput = () => {
		childInputActive = false;
		processingInput = false;
		settleInputIdle?.();
		settleInputIdle = undefined;
	};
	const removeRuntimeEventHandler = launch.onEvent((event) => {
		if (event.event === "runtime.input.started") {
			childInputActive = true;
			processingInput = true;
			if (!settleInputIdle) {
				inputIdle = new Promise<void>((resolve) => {
					settleInputIdle = resolve;
				});
			}
			return;
		}
		if (event.event === "runtime.input.completed") {
			finishInput();
			return;
		}
		if (childInputActive && event.event === "agent.start") finishInput();
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
			try {
				terminal.dispatchInput(data);
			} finally {
				dispatchSettlement ??= Promise.resolve().then(() => {
					dispatchSettlement = undefined;
					if (childInputActive) return;
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
