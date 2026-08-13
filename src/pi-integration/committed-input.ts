import type {
	AgentSession,
} from "@earendil-works/pi-coding-agent";

type CommittedInputSession = {
	_runAgentPrompt(messages: readonly []): Promise<void>;
};

export function continueFromCommittedInput(session: AgentSession): Promise<void> {
	// Pi has no public continuation entry point that also preserves AgentSession's
	// retry, compaction, queue, and settlement behavior. An empty prompt list asks
	// the verified private wrapper to continue from the already committed bootstrap
	// without appending a second model-visible input.
	return (session as unknown as CommittedInputSession)._runAgentPrompt([]);
}
