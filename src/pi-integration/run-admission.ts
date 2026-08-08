import type { AgentSession } from "@earendil-works/pi-coding-agent";

export type ModelRunAdmission = Readonly<{
	admit(): void;
	cancel(reason: unknown): void;
}>;

type ModelRunSession = {
	_runAgentPrompt(messages: unknown): Promise<void>;
};

export function holdModelRunsUntilProjectionAdmission(
	session: AgentSession,
): ModelRunAdmission {
	const modelRunSession = session as unknown as ModelRunSession;
	const nativeRunAgentPrompt = modelRunSession._runAgentPrompt;
	let releaseAdmission!: () => void;
	const admission = new Promise<void>((resolve) => {
		releaseAdmission = resolve;
	});
	let settled = false;
	let canceled = false;
	let cancellation: unknown;

	// session_start can schedule model work without awaiting it. Hold the native
	// Run entry point so no transient rendering event precedes projection ownership.
	modelRunSession._runAgentPrompt = async (messages) => {
		await admission;
		if (canceled) throw cancellation;
		await nativeRunAgentPrompt.call(session, messages);
	};

	return Object.freeze({
		admit() {
			if (settled) return;
			settled = true;
			modelRunSession._runAgentPrompt = nativeRunAgentPrompt;
			releaseAdmission();
		},
		cancel(reason: unknown) {
			if (settled) return;
			settled = true;
			canceled = true;
			cancellation = reason;
			releaseAdmission();
		},
	});
}
