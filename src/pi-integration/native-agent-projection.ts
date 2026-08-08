import {
	AgentSessionRuntime,
	InteractiveMode,
	VERSION,
	getPackageDir,
	initTheme,
	type AgentSession,
	type AgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import {
	getKeybindings,
	setKeybindings,
	type Component,
	type KeybindingsManager,
	type Terminal,
} from "@earendil-works/pi-tui";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
	assertProjectionInteractiveModeInstanceShape,
	IncompatiblePiHostError,
} from "./host-shape.ts";

const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
const FALLBACK_TERMINAL_COLUMNS = 80;
const FALLBACK_TERMINAL_ROWS = 24;

type ProjectionKind = "live" | "dormant";

export type PiNativeAgentProjection = Readonly<{
	kind: ProjectionKind;
	sessionId: string;
	transcript: Component;
	runStatus: Component;
	dispose(): void;
}>;

export type PiNativeProjectionHost = Readonly<{
	createProjection(options: {
		kind: ProjectionKind;
		session: AgentSession;
		services: AgentSessionServices;
	}): Promise<PiNativeAgentProjection>;
}>;

type ProjectionInteractiveMode = {
	renderer: { terminal: Terminal };
	chatContainer: Component;
	statusContainer: Component;
	footerDataProvider: { dispose(): void };
	isInitialized: boolean;
	renderInitialMessages(): void;
	subscribeToAgent(): void;
	stop(): void;
	themeController: {
		activeThemeName?: string;
		terminalColorSchemeUnsubscribe?: () => void;
	};
};

type ThemeInternals = {
	setRegisteredThemes(themes: readonly unknown[]): void;
	setThemeInstance(theme: unknown): void;
	stopThemeWatcher(): void;
};

type GlobalPresentationSnapshot = {
	keybindings: KeybindingsManager;
	theme: unknown;
	activeThemeName: string | undefined;
};

let themeInternalsPromise: Promise<ThemeInternals> | undefined;

export function createPiNativeProjectionHost(options: {
	ownerRuntime: AgentSessionRuntime;
	ownerInteractiveMode?: unknown;
}): PiNativeProjectionHost {
	// Interactive Selection can temporarily rebind the runtime's mutable services;
	// projection construction always restores the actual Owner resource world.
	const ownerServices = options.ownerRuntime.services;
	return Object.freeze({
		createProjection: async ({ kind, session, services }) => {
			if (kind === "dormant") assertDormantSession(session);
			const themeInternals = await loadThemeInternals();
			const globalSnapshot = captureGlobalPresentation(
				options.ownerInteractiveMode,
			);
			const projectionRuntime = new AgentSessionRuntime(
				session,
				services,
				async () => {
					throw new Error("Presentation projection cannot replace its exact session");
				},
				services.diagnostics,
			);
			let mode: ProjectionInteractiveMode | undefined;
			try {
				mode = new InteractiveMode(projectionRuntime, {
					migratedProviders: [],
					initialImages: [],
					initialMessages: [],
					verbose: false,
				}) as unknown as ProjectionInteractiveMode;
				restoreGlobalPresentation(
					globalSnapshot,
					themeInternals,
					ownerServices,
				);
				assertProjectionInteractiveModeInstanceShape(mode);
				// Keep Pi's concrete renderer allocation, but detach its process terminal
				// before any Run event can write progress, title, or frame output.
				mode.renderer.terminal = new ProjectionTerminal();
				// Transcript and Run-status projection does not expose Pi's footer. Close
				// its per-mode git watcher now; the allocated provider remains mode-owned
				// and its native disposal is idempotent.
				mode.footerDataProvider.dispose();
				// Native event handling lazily calls init(). Projection presentation owns
				// no terminal input loop, so mark the fully constructed detached mode ready
				// before subscribing and reconstructing its durable transcript.
				mode.isInitialized = true;
				mode.renderInitialMessages();
				mode.subscribeToAgent();
				return createProjectionResource(kind, session.sessionId, mode, projectionRuntime);
			} catch (error) {
				try {
					restoreGlobalPresentation(
						globalSnapshot,
						themeInternals,
						ownerServices,
					);
				} catch (restoreError) {
					if (mode) disposeMode(mode, projectionRuntime);
					throw new AggregateError(
						[error, restoreError],
						"Pi-native projection construction and Owner presentation restoration failed",
					);
				}
				if (mode) disposeMode(mode, projectionRuntime);
				throw error;
			}
		},
	});
}

function createProjectionResource(
	kind: ProjectionKind,
	sessionId: string,
	mode: ProjectionInteractiveMode,
	runtime: AgentSessionRuntime,
): PiNativeAgentProjection {
	let disposed = false;
	return Object.freeze({
		kind,
		sessionId,
		transcript: mode.chatContainer,
		runStatus: mode.statusContainer,
		dispose() {
			if (disposed) return;
			disposed = true;
			disposeMode(mode, runtime);
		},
	});
}

function disposeMode(
	mode: ProjectionInteractiveMode,
	runtime: AgentSessionRuntime,
): void {
	const cleanupErrors: unknown[] = [];
	const attempt = (cleanup: () => void) => {
		try {
			cleanup();
		} catch (error) {
			cleanupErrors.push(error);
		}
	};
	attempt(() => mode.themeController.terminalColorSchemeUnsubscribe?.());
	mode.themeController.terminalColorSchemeUnsubscribe = undefined;
	attempt(() => mode.stop());
	attempt(() => runtime.setBeforeSessionInvalidate(undefined));
	attempt(() => runtime.setRebindSession(undefined));
	if (cleanupErrors.length > 0) {
		throw new AggregateError(cleanupErrors, "Pi-native projection disposal failed");
	}
}

function assertDormantSession(session: AgentSession): void {
	if (!session.isIdle) {
		throw new Error("Dormant projection requires an idle presentation-only session");
	}
	if (session.getActiveToolNames().length > 0) {
		throw new Error("Dormant projection session must not expose active tools");
	}
}

function captureGlobalPresentation(
	ownerInteractiveMode: unknown,
): GlobalPresentationSnapshot {
	const globals = globalThis as Record<PropertyKey, unknown>;
	const ownerMode = ownerInteractiveMode as {
		themeController?: { activeThemeName?: unknown };
	};
	const activeThemeName = ownerMode?.themeController?.activeThemeName;
	return {
		keybindings: getKeybindings(),
		theme: globals[THEME_KEY],
		activeThemeName: typeof activeThemeName === "string"
			? activeThemeName
			: undefined,
	};
}

function restoreGlobalPresentation(
	snapshot: GlobalPresentationSnapshot,
	themeInternals: ThemeInternals,
	ownerServices: AgentSessionServices,
): void {
	try {
		themeInternals.setRegisteredThemes(
			ownerServices.resourceLoader.getThemes().themes,
		);
		if (snapshot.theme === undefined) {
			// Direct SDK hosts can construct a coordinator without first constructing
			// Pi's Owner InteractiveMode. Give that host the Owner's configured theme;
			// the real interactive path always restores the exact captured instance below.
			themeInternals.stopThemeWatcher();
			initTheme(
				snapshot.activeThemeName ?? ownerServices.settingsManager.getThemeSetting(),
			);
		} else if (
			snapshot.activeThemeName !== undefined &&
			snapshot.activeThemeName !== "<in-memory>"
		) {
			initTheme(snapshot.activeThemeName, true);
		} else {
			themeInternals.setThemeInstance(snapshot.theme);
		}
	} finally {
		setKeybindings(snapshot.keybindings);
	}
}


async function loadThemeInternals(): Promise<ThemeInternals> {
	themeInternalsPromise ??= import(
		pathToFileURL(
			join(
				getPackageDir(),
				"dist",
				"modes",
				"interactive",
				"theme",
				"theme.js",
			),
		).href
	).then((moduleValue: Record<PropertyKey, unknown>) => {
		for (const member of [
			"setRegisteredThemes",
			"setThemeInstance",
			"stopThemeWatcher",
		] as const) {
			if (typeof moduleValue[member] !== "function") {
				throw new IncompatiblePiHostError(`InteractiveTheme.${member}`, VERSION);
			}
		}
		return moduleValue as unknown as ThemeInternals;
	});
	return themeInternalsPromise;
}

class ProjectionTerminal implements Terminal {
	readonly columns = process.stdout.columns ?? FALLBACK_TERMINAL_COLUMNS;
	readonly rows = process.stdout.rows ?? FALLBACK_TERMINAL_ROWS;
	readonly kittyProtocolActive = false;

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}
