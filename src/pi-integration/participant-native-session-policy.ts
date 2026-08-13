import {
	InteractiveMode,
	type AgentSessionRuntime,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const PARTICIPANT_NATIVE_SESSION_REPLACEMENT_MESSAGE =
	"Return to Owner before replacing or forking the native session.";

type ParticipantInteractiveMode = {
	runtimeHost: AgentSessionRuntime;
	showUserMessageSelector(): void;
	showSessionSelector(): void;
};

const PARTICIPANT_SESSIONS_REGISTRY_KEY =
	"__piAgentCoordinationParticipantNativeSessionPolicy";
const INTERACTIVE_MODE_PATCH_REGISTRY_KEY =
	"__piAgentCoordinationParticipantNativeSessionPolicyPatches";
const globalPolicyRegistry = globalThis as typeof globalThis & {
	[PARTICIPANT_SESSIONS_REGISTRY_KEY]?: WeakSet<object>;
	[INTERACTIVE_MODE_PATCH_REGISTRY_KEY]?: WeakSet<object>;
};
const participantSessions =
	globalPolicyRegistry[PARTICIPANT_SESSIONS_REGISTRY_KEY] ??= new WeakSet();
const patchedPrototypes =
	globalPolicyRegistry[INTERACTIVE_MODE_PATCH_REGISTRY_KEY] ??= new WeakSet();

installParticipantInteractiveCommandGate();

/**
 * Reject participant session replacement both before interactive selectors open
 * and at Pi's lifecycle boundary for non-interactive callers.
 */
export function registerParticipantNativeSessionPolicy(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		participantSessions.add(ctx.sessionManager);
	});
	pi.on("session_before_fork", (_event, ctx) =>
		cancelParticipantNativeSessionReplacement(ctx)
	);
	pi.on("session_before_switch", (_event, ctx) =>
		cancelParticipantNativeSessionReplacement(ctx)
	);
}

function installParticipantInteractiveCommandGate(): void {
	const prototype = InteractiveMode.prototype as unknown as ParticipantInteractiveMode;
	if (patchedPrototypes.has(prototype)) return;
	patchedPrototypes.add(prototype);

	const showUserMessageSelector = prototype.showUserMessageSelector;
	prototype.showUserMessageSelector = function gatedUserMessageSelector(
		this: ParticipantInteractiveMode,
	): void {
		if (rejectParticipantInteractiveCommand(this)) return;
		showUserMessageSelector.call(this);
	};

	const showSessionSelector = prototype.showSessionSelector;
	prototype.showSessionSelector = function gatedSessionSelector(
		this: ParticipantInteractiveMode,
	): void {
		if (rejectParticipantInteractiveCommand(this)) return;
		showSessionSelector.call(this);
	};
}

function rejectParticipantInteractiveCommand(mode: ParticipantInteractiveMode): boolean {
	const session = mode.runtimeHost.session;
	if (!participantSessions.has(session.sessionManager)) return false;

	session.extensionRunner
		.getUIContext()
		.notify(PARTICIPANT_NATIVE_SESSION_REPLACEMENT_MESSAGE, "error");
	return true;
}

function cancelParticipantNativeSessionReplacement(
	ctx: ExtensionContext,
): { cancel: true } {
	ctx.ui.notify(PARTICIPANT_NATIVE_SESSION_REPLACEMENT_MESSAGE, "error");
	return { cancel: true };
}
