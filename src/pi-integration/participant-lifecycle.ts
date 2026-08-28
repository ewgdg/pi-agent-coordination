import type {
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
	InputEventResult,
	MessageEndEvent,
} from "@earendil-works/pi-coding-agent";

export type ParticipantHumanInput = Readonly<{
	text: string;
	images: InputEvent["images"];
	submissionSequence?: number;
}>;

export type ParticipantHumanInputDisposition = "continue" | "submitted" | "discarded";

export type ParticipantToolResult = Readonly<{
	message: MessageEndEvent["message"];
}>;

export type ParticipantToolExecution = Readonly<{
	toolCallId: string;
	toolName: string;
}>;

export type GuardedParticipantToolResult = Readonly<{
	message?: MessageEndEvent["message"];
	rejectedAnswer?: string;
	reason?: string;
}>;

export type ParticipantLifecycleHandlers = Readonly<{
	executionStarted(submissionSequence?: number): Promise<void>;
	humanInputSubmitted(input: ParticipantHumanInput): Promise<ParticipantHumanInputDisposition>;
	primaryInputQueued(): Promise<void>;
	humanInputMode(): Promise<"agent" | "answer">;
	toolResultCommitting(
		input: ParticipantToolResult,
	): Promise<GuardedParticipantToolResult | undefined>;
	toolExecutionStarted(input: ParticipantToolExecution): Promise<void>;
	safeBoundaryReached(): Promise<void>;
	executionEnded(): Promise<void>;
}>;

/** Bind Pi lifecycle events to process-neutral participant intentions. */
export function registerParticipantLifecycle(
	pi: ExtensionAPI,
	handlers: ParticipantLifecycleHandlers,
	options: Readonly<{ registerInput?: boolean }> = {},
): void {
	// agent_start is the one awaited Pi boundary shared by native prompts,
	// custom Delivery turns, queued continuations, and automatic retries.
	pi.on("agent_start", () => handlers.executionStarted());
	if (options.registerInput !== false) registerParticipantInputLifecycle(pi, handlers);
	// message_end is Pi's final awaited hook before it synchronously publishes the
	// native result. A Run fence can still turn a submitted candidate into the one
	// interruption result here; attention remains until later transcript proof.
	pi.on("message_end", async (event, ctx) => {
		const guarded = await handlers.toolResultCommitting({
			message: event.message,
		});
		if (!guarded) return;
		if (guarded.rejectedAnswer !== undefined) {
			const currentDraft = ctx.ui.getEditorText();
			if (currentDraft !== guarded.rejectedAnswer) {
				// The editor remains usable during result commitment. Restore the
				// rejected candidate without discarding text typed after submission.
				ctx.ui.setEditorText(
					currentDraft.length === 0
						? guarded.rejectedAnswer
						: `${guarded.rejectedAnswer}\n${currentDraft}`,
				);
			}
			ctx.ui.notify(
				`Human Answer was not committed: ${guarded.reason ?? "the request ended"}`,
				"error",
			);
		}
		return guarded.message ? { message: guarded.message } : undefined;
	});
	pi.on("tool_execution_start", (event) =>
		handlers.toolExecutionStarted({
			toolCallId: event.toolCallId,
			toolName: event.toolName,
		})
	);
	// Pi awaits turn_end only after the complete issued tool batch and before it
	// constructs the next model context, making this the Steer freeze boundary.
	pi.on("turn_end", () => handlers.safeBoundaryReached());
	pi.on("agent_end", () => handlers.executionEnded());
}

export function registerParticipantInputLifecycle(
	pi: ExtensionAPI,
	handlers: ParticipantLifecycleHandlers,
): void {
	pi.on("input", createParticipantInputHandler(handlers));
}

export function createParticipantInputHandler(
	handlers: ParticipantLifecycleHandlers,
	onDiscarded: () => Promise<void> = () => Promise.resolve(),
	options: Readonly<{ deferPrimaryInputQueued?: boolean }> = {},
): (event: InputEvent, ctx: ExtensionContext) => Promise<InputEventResult> {
	return async (event, ctx) => {
		if (event.source !== "interactive") return { action: "continue" };
		if (event.streamingBehavior === "followUp") return { action: "continue" };
		try {
			const disposition = await handlers.humanInputSubmitted({
				text: event.text,
				images: event.images,
			});
			if (disposition === "discarded") await onDiscarded();
			if (
				disposition === "continue" &&
				event.streamingBehavior === "steer" &&
				options.deferPrimaryInputQueued !== false
			) deferPrimaryInputQueued(handlers, ctx);
			return disposition === "continue"
				? { action: "continue" }
				: { action: "handled" };
		} catch (error) {
			const answeringHumanRequest = await handlers.humanInputMode() === "answer";
			if (answeringHumanRequest) ctx.ui.setEditorText(event.text);
			ctx.ui.notify(
				`${answeringHumanRequest ? "Human Answer was not submitted" : "Agent input failed"}: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return { action: "handled" };
		}
	};
}

export function deferPrimaryInputQueued(
	handlers: ParticipantLifecycleHandlers,
	ctx: ExtensionContext,
): void {
	// Pi queues steering only after every input handler returns. Defer the wait
	// preemption so its tool result cannot outrun this user message.
	setImmediate(() => {
		void handlers.primaryInputQueued().catch((error: unknown) => {
			ctx.ui.notify(
				`Agent input failed: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		});
	});
}
