import type { AgentSession } from "@earendil-works/pi-coding-agent";

type ExtensionBindings = Parameters<AgentSession["bindExtensions"]>[0];

type BoundSession = {
	_extensionUIContext: ExtensionBindings["uiContext"];
	_extensionMode: ExtensionBindings["mode"];
	_extensionCommandContextActions: ExtensionBindings["commandContextActions"];
	_extensionAbortHandler: ExtensionBindings["abortHandler"];
	_extensionShutdownHandler: ExtensionBindings["shutdownHandler"];
	_extensionErrorListener: ExtensionBindings["onError"];
};

export function copyExtensionBindings(
	source: AgentSession,
	target: AgentSession,
): ExtensionBindings {
	const bound = source as unknown as BoundSession;
	return {
		uiContext: bound._extensionUIContext,
		mode: bound._extensionMode,
		commandContextActions: bound._extensionCommandContextActions,
		abortHandler: () => {
			void target.abort();
		},
		shutdownHandler: bound._extensionShutdownHandler,
		onError: bound._extensionErrorListener,
	};
}
