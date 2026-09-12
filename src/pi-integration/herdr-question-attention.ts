import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type HumanQuestionAttentionSource = Readonly<{
	hasPendingHumanQuestions(): boolean;
	addAgentActivityChangeHandler(handler: () => void): () => void;
}>;

/** Root-session presentation only; absence of a Herdr listener is harmless. */
export function registerHerdrQuestionAttention(
	pi: ExtensionAPI,
	resolveSource: () => HumanQuestionAttentionSource | undefined,
): void {
	let unsubscribe: (() => void) | undefined;
	let active = false;
	const publish = (pending: boolean) => {
		// Herdr reference-counts activations, so activity refreshes and overlapping
		// questions must not acquire additional blockers for the same episode.
		if (pending === active) return;
		active = pending;
		pi.events.emit("herdr:blocked", active
			? { active: true, label: "An agent needs your input" }
			: { active: false });
	};
	pi.on("resources_discover", () => {
		if (unsubscribe) return;
		const source = resolveSource();
		if (!source) return;
		const refresh = () => publish(source.hasPendingHumanQuestions());
		unsubscribe = source.addAgentActivityChangeHandler(refresh);
		// Herdr initializes root-session state in session_start. Resource discovery
		// runs after every startup handler, including when extension order changes.
		refresh();
	});
	pi.on("session_shutdown", () => {
		unsubscribe?.();
		unsubscribe = undefined;
		publish(false);
	});
}
