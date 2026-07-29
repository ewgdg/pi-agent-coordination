import { dirname, join } from "node:path";
import { findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

import type {
	AgentSession as AgentSessionType,
	AgentSessionRuntime as AgentSessionRuntimeType,
} from "@earendil-works/pi-coding-agent";

const SUPPORTED_PI_VERSION = "0.82.1";
const CAPTURE_STATE_KEY = "__piAgentSupervisorRuntimeCapture0821";

type RuntimeCaptureState = {
	runtime?: AgentSessionRuntimeType;
	waiters: Array<(runtime: AgentSessionRuntimeType) => void>;
	patched: boolean;
	interactiveModePatched: boolean;
	boundInteractiveSessions: WeakSet<AgentSessionType>;
	presentedSessions: WeakMap<MutableInteractiveMode, AgentSessionType>;
};

type RuntimeConstructor = {
	prototype: {
		setRebindSession(
			rebindSession?: (session: AgentSessionType) => Promise<void>,
		): void;
	};
};

type HostPiModule = typeof import("@earendil-works/pi-coding-agent") & {
	AgentSessionRuntime: RuntimeConstructor;
};

type MutableInteractiveMode = {
	session: AgentSessionType;
	ui: {
		requestRender(force?: boolean): void;
	};
	getUserInput(): Promise<string>;
	bindCurrentSessionExtensions(): Promise<void>;
	rebindCurrentSession(options?: { renderBeforeBind?: boolean }): Promise<void>;
	setWorkingVisible(visible: boolean): void;
	clearStatusIndicator(kind?: "working"): void;
	showError(message: string): void;
};

type ExtensionBindings = Parameters<AgentSessionType["bindExtensions"]>[0];

type MutableAgentSession = {
	extensionRunner: AgentSessionType["extensionRunner"];
	_extensionUIContext?: ExtensionBindings["uiContext"];
	_extensionMode?: ExtensionBindings["mode"];
	_extensionCommandContextActions?: ExtensionBindings["commandContextActions"];
	_extensionAbortHandler?: ExtensionBindings["abortHandler"];
	_extensionShutdownHandler?: ExtensionBindings["shutdownHandler"];
	_extensionErrorListener?: ExtensionBindings["onError"];
	_applyExtensionBindings(runner: AgentSessionType["extensionRunner"]): void;
};

function refreshExtensionHostBindings(
	session: AgentSessionType,
	bindings: ExtensionBindings,
): void {
	const mutableSession = session as unknown as MutableAgentSession;
	if (bindings.uiContext !== undefined) mutableSession._extensionUIContext = bindings.uiContext;
	if (bindings.mode !== undefined) mutableSession._extensionMode = bindings.mode;
	if (bindings.commandContextActions !== undefined) {
		mutableSession._extensionCommandContextActions = bindings.commandContextActions;
	}
	if (bindings.abortHandler !== undefined) {
		mutableSession._extensionAbortHandler = bindings.abortHandler;
	}
	if (bindings.shutdownHandler !== undefined) {
		mutableSession._extensionShutdownHandler = bindings.shutdownHandler;
	}
	if (bindings.onError !== undefined) mutableSession._extensionErrorListener = bindings.onError;
	mutableSession._applyExtensionBindings(mutableSession.extensionRunner);
}

function synchronizeWorkingIndicator(interactiveMode: MutableInteractiveMode): void {
	if (interactiveMode.session.isStreaming) {
		interactiveMode.setWorkingVisible(true);
	} else {
		interactiveMode.clearStatusIndicator("working");
	}
}

const globalCapture = globalThis as typeof globalThis & {
	[CAPTURE_STATE_KEY]?: RuntimeCaptureState;
};
const captureState = (globalCapture[CAPTURE_STATE_KEY] ??= {
	waiters: [],
	patched: false,
	interactiveModePatched: false,
	boundInteractiveSessions: new WeakSet(),
	presentedSessions: new WeakMap(),
});

// Resolve from the running CLI entry point. The extension may have its own local SDK
// dependency, but only the host Pi package owns the runtime that InteractiveMode binds.
const hostPiPackage = findPackageJSON(
	"@earendil-works/pi-coding-agent",
	pathToFileURL(realpathSync(process.argv[1] ?? import.meta.filename)).href,
);
if (!hostPiPackage) {
	throw new Error("Cannot locate the Pi package that owns the running CLI");
}
const hostPiEntry = join(dirname(hostPiPackage), "dist", "index.js");
const hostPi = (await import(pathToFileURL(hostPiEntry).href)) as HostPiModule;

if (hostPi.VERSION !== SUPPORTED_PI_VERSION) {
	throw new Error(
		`In-process supervisor requires Pi ${SUPPORTED_PI_VERSION}; running ${hostPi.VERSION}`,
	);
}

if (!captureState.interactiveModePatched) {
	const interactivePrototype = hostPi.InteractiveMode.prototype as unknown as MutableInteractiveMode;
	const originalBindCurrentSessionExtensions =
		interactivePrototype.bindCurrentSessionExtensions;
	interactivePrototype.bindCurrentSessionExtensions = async function bindRetainedExtensions(): Promise<void> {
		const session = this.session;
		if (!captureState.boundInteractiveSessions.has(session)) {
			await originalBindCurrentSessionExtensions.call(this);
			captureState.boundInteractiveSessions.add(session);
			return;
		}

		const originalBindExtensions = session.bindExtensions;
		session.bindExtensions = async (bindings: ExtensionBindings): Promise<void> => {
			refreshExtensionHostBindings(session, bindings);
		};
		try {
			await originalBindCurrentSessionExtensions.call(this);
		} finally {
			session.bindExtensions = originalBindExtensions;
		}
	};
	const originalGetUserInput = interactivePrototype.getUserInput;
	interactivePrototype.getUserInput = async function getMultiplexedUserInput(): Promise<string> {
		// Native Pi awaits one prompt before reading again. A multiplexer must keep
		// reading so an idle selected session remains usable while another is active.
		for (;;) {
			const input = await originalGetUserInput.call(this);
			const targetSession = this.session;
			void targetSession.prompt(input).catch((error: unknown) => {
				this.showError(error instanceof Error ? error.message : String(error));
			});
		}
	};
	const originalRebindCurrentSession = interactivePrototype.rebindCurrentSession;
	interactivePrototype.rebindCurrentSession = async function rebindRetainedSession(
		options?: { renderBeforeBind?: boolean },
	): Promise<void> {
		const previousSession = captureState.presentedSessions.get(this);
		const selectedSession = this.session;
		// Native rebind awaits extension startup. Synchronize first so the previous
		// session's indicator cannot remain visibly stale during that async gap.
		synchronizeWorkingIndicator(this);
		await originalRebindCurrentSession.call(this, options);
		captureState.presentedSessions.set(this, selectedSession);
		if (previousSession && previousSession !== selectedSession) {
			// A retained transcript can be shorter without shrinking above the old
			// viewport origin. Rebuild the selected Agent's full native frame so its
			// editor and footer return to the live terminal bottom.
			this.ui.requestRender(true);
		}
		synchronizeWorkingIndicator(this);
	};
	captureState.interactiveModePatched = true;
}

if (!captureState.patched) {
	const originalSetRebindSession = hostPi.AgentSessionRuntime.prototype.setRebindSession;
	hostPi.AgentSessionRuntime.prototype.setRebindSession = function setRebindSessionAndCapture(
		rebindSession?: (session: AgentSessionType) => Promise<void>,
	): void {
		originalSetRebindSession.call(this, rebindSession);
		if (!rebindSession || captureState.runtime) return;

		captureState.runtime = this as unknown as AgentSessionRuntimeType;
		for (const resolve of captureState.waiters.splice(0)) resolve(captureState.runtime);
	};
	captureState.patched = true;
}

export function captureInteractiveRuntime(): Promise<AgentSessionRuntimeType> {
	if (captureState.runtime) return Promise.resolve(captureState.runtime);
	return new Promise((resolve) => captureState.waiters.push(resolve));
}

export function getHostPiSdk(): typeof import("@earendil-works/pi-coding-agent") {
	return hostPi;
}
