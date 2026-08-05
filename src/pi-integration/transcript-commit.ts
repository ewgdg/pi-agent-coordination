import type { AgentSession } from "@earendil-works/pi-coding-agent";

type AgentSessionEvent = Parameters<Parameters<AgentSession["subscribe"]>[0]>[0];

export async function sendAndAwaitTranscriptCommit(options: {
	session: AgentSession;
	matchesCandidate(event: AgentSessionEvent): boolean;
	inspectCommit(): boolean;
	send(): Promise<void>;
	onDispatched(completion: Promise<void>): void;
}): Promise<boolean> {
	const { session, matchesCandidate, inspectCommit, send, onDispatched } = options;
	let settleCommit!: (committed: boolean) => void;
	let rejectCommit!: (error: unknown) => void;
	const commit = new Promise<boolean>((resolve, reject) => {
		settleCommit = resolve;
		rejectCommit = reject;
	});
	let settled = false;
	// Pi emits message_end before synchronously appending the entry. The first
	// microtask observes that append; when dispatch resolves without that event,
	// the second microtask establishes authoritative non-commit after inspection.
	const inspectAfterPersistence = () => queueMicrotask(() => {
		if (settled) return;
		try {
			if (!inspectCommit()) return;
			settled = true;
			settleCommit(true);
		} catch (error) {
			settled = true;
			rejectCommit(error);
		}
	});
	const unsubscribe = session.subscribe((event) => {
		if (matchesCandidate(event)) inspectAfterPersistence();
	});
	try {
		const completion = send();
		onDispatched(completion);
		void completion.then(
			() => {
				if (settled) return;
				inspectAfterPersistence();
				queueMicrotask(() => {
					if (settled) return;
					settled = true;
					settleCommit(false);
				});
			},
			(error) => {
				if (settled) return;
				settled = true;
				rejectCommit(error);
			},
		);
		return await commit;
	} finally {
		unsubscribe();
	}
}
