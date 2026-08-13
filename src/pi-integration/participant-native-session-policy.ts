import {
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const PARTICIPANT_NATIVE_SESSION_REPLACEMENT_MESSAGE =
	"Return to Owner before replacing or forking the native session.";

/** Reject participant session replacement at Pi's public lifecycle seam. */
export function registerParticipantNativeSessionPolicy(pi: ExtensionAPI): void {
	pi.on("session_before_fork", (_event, ctx) =>
		cancelParticipantNativeSessionReplacement(ctx)
	);
	pi.on("session_before_switch", (_event, ctx) =>
		cancelParticipantNativeSessionReplacement(ctx)
	);
}

function cancelParticipantNativeSessionReplacement(
	ctx: ExtensionContext,
): { cancel: true } {
	ctx.ui.notify(PARTICIPANT_NATIVE_SESSION_REPLACEMENT_MESSAGE, "error");
	return { cancel: true };
}
