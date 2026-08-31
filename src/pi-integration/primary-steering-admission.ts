import type { AgentSession } from "@earendil-works/pi-coding-agent";

/**
 * Observe one interactive steering prompt only after Pi has added its message to
 * the native queue. Agent Wait must not resume from the earlier input hook: that
 * can let its tool result start a model call before AgentSession queues the text.
 */
export function bindPrimarySteeringAdmission(
	session: AgentSession,
	onQueued: () => void | Promise<void>,
	onError: (error: unknown) => void,
): () => void {
	const originalPrompt = session.prompt.bind(session);
	const observedPrompt: AgentSession["prompt"] = async (text, options) => {
		const observesPrimarySteering =
			options?.streamingBehavior === "steer" &&
			(options.source ?? "interactive") === "interactive";
		if (!observesPrimarySteering) return originalPrompt(text, options);

		const pendingMessageCountBeforePrompt = session.pendingMessageCount;
		const existingPreflightResult = options.preflightResult;
		return originalPrompt(text, {
			...options,
			preflightResult(success) {
				existingPreflightResult?.(success);
				if (
					!success ||
					session.pendingMessageCount <= pendingMessageCountBeforePrompt
				) return;
				void Promise.resolve(onQueued()).catch(onError);
			},
		});
	};
	session.prompt = observedPrompt;

	return () => {
		if (session.prompt === observedPrompt) session.prompt = originalPrompt;
	};
}
