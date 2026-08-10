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
	type TUI,
	type TuiInputListener,
} from "@earendil-works/pi-tui";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
	assertProjectionInteractiveModeInstanceShape,
	assertPrioritizedTuiInputListenerShape,
	IncompatiblePiHostError,
} from "./host-shape.ts";

const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
const FALLBACK_TERMINAL_COLUMNS = 80;
const FALLBACK_TERMINAL_ROWS = 24;

export type PiNativeAgentProjection = Readonly<{
	sessionId: string;
	presentation: Component;
	resize(columns: number, rows: number): void;
	dispatchInput(data: string): void;
	addChangeHandler(handler: () => void): () => void;
	addFailureHandler(handler: (error: unknown) => void): () => void;
	addExitRequestHandler(handler: () => void): () => void;
	ready(): Promise<void>;
	cancelInitialization(error: unknown): Promise<void> | undefined;
	dispose(): Promise<void>;
}>;

export type PiNativeProjectionHost = Readonly<{
	createProjection(options: {
		session: AgentSession;
		services: AgentSessionServices;
		exposeWhileInitializing?: boolean;
	}): Promise<PiNativeAgentProjection>;
}>;

type ProjectionInteractiveMode = {
	defaultEditor: ProjectionEditor;
	editor: ProjectionEditor;
	footerDataProvider: {
		setupGitWatcher(): void;
	};
	renderer: TUI & {
		compositeOverlays(
			lines: string[],
			termWidth: number,
			termHeight: number,
		): string[];
		previousScreen: string[];
		doRender(): void;
		renderNow(force?: boolean): void;
	};
	isInitialized: boolean;
	init(): Promise<void>;
	getUserInput(): Promise<string>;
	handleFatalRuntimeError(prefix: string, error: unknown): Promise<void>;
	registerSignalHandlers(): void;
	resetExtensionUI(): void;
	shutdownRequested: boolean;
	shutdown(): Promise<void>;
	showError(message: string): void;
	showExtensionConfirm(...args: unknown[]): Promise<unknown>;
	showExtensionCustom(...args: unknown[]): Promise<unknown>;
	showExtensionEditor(...args: unknown[]): Promise<unknown>;
	showExtensionInput(...args: unknown[]): Promise<unknown>;
	showExtensionSelector(...args: unknown[]): Promise<unknown>;
	stop(): void;
	unregisterSignalHandlers(): void;
	themeController: {
		activeThemeName?: string;
		applyFromSettings(): Promise<void>;
		terminalColorSchemeUnsubscribe?: () => void;
	};
};

type ProjectionEditor = {
	onSubmit?: (text: string) => void | Promise<void>;
	setText(text: string): void;
};

type ThemeInternals = {
	onThemeChange(callback: () => void): void;
	setRegisteredThemes(themes: readonly unknown[]): void;
	setThemeInstance(theme: unknown): void;
	stopThemeWatcher(): void;
};

type FooterDataProviderConstructor = Function & Readonly<{
	prototype: {
		setupGitWatcher(): void;
	};
}>;

type GlobalPresentationSnapshot = {
	keybindings: KeybindingsManager;
	theme: unknown;
	activeThemeName: string | undefined;
};

type ProjectionTerminalState = Readonly<{
	columns: number;
	rows: number;
	kittyProtocolActive: boolean;
}>;

let themeInternalsPromise: Promise<ThemeInternals> | undefined;
let footerDataProviderConstructorPromise: Promise<FooterDataProviderConstructor> | undefined;
let projectionInitializationTail = Promise.resolve();

export function addPrioritizedTuiInputListener(
	tui: TUI,
	listener: TuiInputListener,
): () => void {
	assertPrioritizedTuiInputListenerShape(tui, VERSION);
	const listeners = tui.inputListeners as Set<TuiInputListener>;
	const removeListener = tui.addInputListener(listener);
	if (!listeners.delete(listener)) {
		removeListener();
		throw new IncompatiblePiHostError("TUI.inputListeners registration", VERSION);
	}
	const existingListeners = [...listeners];
	listeners.clear();
	listeners.add(listener);
	for (const existingListener of existingListeners) {
		listeners.add(existingListener);
	}
	let removed = false;
	return () => {
		if (removed) return;
		removed = true;
		removeListener();
		listeners.delete(listener);
	};
}

export function createPiNativeProjectionHost(options: {
	ownerRuntime: AgentSessionRuntime;
	ownerInteractiveMode?: unknown;
}): PiNativeProjectionHost {
	// InteractiveMode construction mutates process-global presentation state;
	// every projection restores the continuously bound Owner resource world.
	const ownerServices = options.ownerRuntime.services;
	const terminalState = createProjectionTerminalStateReader(
		options.ownerInteractiveMode,
	);
	return Object.freeze({
		createProjection: ({ session, services, exposeWhileInitializing }) => {
			let publish!: (projection: PiNativeAgentProjection) => void;
			let rejectPublication!: (error: unknown) => void;
			const publication = new Promise<PiNativeAgentProjection>((resolve, reject) => {
				publish = resolve;
				rejectPublication = reject;
			});
			let finishInitialization!: () => void;
			const initializationFinished = new Promise<void>((resolve) => {
				finishInitialization = resolve;
			});
			let published = false;
			void serializeProjectionInitialization(async () => {
				const [themeInternals, FooterDataProvider] = await Promise.all([
					loadThemeInternals(),
					loadFooterDataProviderConstructor(),
				]);
				const globalSnapshot = captureGlobalPresentation(
					options.ownerInteractiveMode,
				);
				const projectionRuntime = new AgentSessionRuntime(
					session,
					services,
					async () => {
						throw new Error("Agent projection cannot replace its exact session");
					},
					services.diagnostics,
				);
				let mode: ProjectionInteractiveMode | undefined;
				let projectionFailures: ProjectionFailures | undefined;
				let initialPresentationApplied = false;
				let initializationState: "pending" | "resolved" | "rejected" = "pending";
				let initializationCancellation: Readonly<{ error: unknown }> | undefined;
				let resolveReadyPromise!: () => void;
				let rejectReadyPromise!: (error: unknown) => void;
				const ready = new Promise<void>((resolve, reject) => {
					resolveReadyPromise = resolve;
					rejectReadyPromise = reject;
				});
				const resolveReady = () => {
					if (initializationState !== "pending") return false;
					initializationState = "resolved";
					resolveReadyPromise();
					return true;
				};
				const rejectReady = (error: unknown) => {
					if (initializationState !== "pending") return false;
					initializationState = "rejected";
					rejectReadyPromise(error);
					return true;
				};
				void ready.catch(() => undefined);
				try {
					const restoreFooterWatcherConstruction = suppressFooterWatcherConstruction(
						FooterDataProvider,
					);
					try {
						// Pi currently starts the footer's git watcher before its constructor's
						// final fallible theme/resource work. Defer that watcher until the whole
						// mode is reachable so every later failure can use normal mode disposal.
						mode = new InteractiveMode(projectionRuntime, {
							migratedProviders: [],
							initialImages: [],
							initialMessages: [],
							verbose: false,
							tuiMode: "fullscreen",
						}) as unknown as ProjectionInteractiveMode;
					} finally {
						restoreFooterWatcherConstruction();
					}
					const changes = new ProjectionChanges();
					const failures = new ProjectionFailures();
					projectionFailures = failures;
					const exitRequests = new ProjectionExitRequests();
					let renderFailure: Readonly<{ error: unknown }> | undefined;
					const terminal = new ProjectionTerminal(terminalState);
					// Detach before structural validation: compatibility cleanup invokes native
					// UI reset/stop paths that must never write through ProcessTerminal.
					mode.renderer.terminal = terminal;
					assertProjectionInteractiveModeInstanceShape(mode);
					const startupUICancellation = installEmbeddedInitializationCancellation(mode);
					mode.footerDataProvider.setupGitWatcher();
					// Construction installs the child's process-global theme resources and
					// keybindings. Restore the continuously bound Owner before initialization;
					// the child retains its own managers through direct instance references.
					restoreGlobalPresentation(
						globalSnapshot,
						themeInternals,
						ownerServices,
						options.ownerInteractiveMode,
					);
					const applyProjectionPresentation =
						mode.themeController.applyFromSettings.bind(mode.themeController);
					mode.themeController.applyFromSettings = async () => {
						try {
							await applyProjectionPresentation();
						} finally {
							// applyFromSettings is Pi's last incidental theme application before
							// session_start. Restore here so explicit extension or Owner changes
							// made during session_start remain Workflow-global.
							restoreGlobalPresentation(
								globalSnapshot,
								themeInternals,
								ownerServices,
								options.ownerInteractiveMode,
							);
							initialPresentationApplied = true;
						}
					};
					installEmbeddedRenderFailurePolicy(mode, (error) => {
						renderFailure ??= { error };
						failures.notify(error);
					});
					installEmbeddedLifecyclePolicy(mode, () => exitRequests.notify());
					// Keep the child renderer's own layout loop active against the inert
					// terminal, then notify any attached Owner overlay from the same native
					// render signal. Replacing the render loop would lose fullscreen layout.
					const requestNativeRender = mode.renderer.requestRender.bind(mode.renderer);
					mode.renderer.requestRender = (force) => {
						requestNativeRender(force);
						changes.notify();
					};
					const resource = createProjectionResource(
						session.sessionId,
						mode,
						projectionRuntime,
						terminal,
						changes,
						failures,
						exitRequests,
						ready,
						initializationFinished,
						(error) => {
							if (!rejectReady(error)) return false;
							initializationCancellation = { error };
							startupUICancellation.cancel();
							return true;
						},
						() => mode!.isInitialized,
						() => renderFailure,
					);
					if (exposeWhileInitializing) {
						published = true;
						publish(resource);
					}
					await mode.init();
					if (initializationCancellation) throw initializationCancellation.error;
					// Validate one complete frame before model admission. The renderer's own
					// scheduled loop is guarded below, so asynchronous component failures are
					// retained and become exact Run startup failure rather than process failure.
					mode.renderer.renderNow(true);
					if (renderFailure) throw renderFailure.error;
					restoreOwnerPresentationOwnership(
						themeInternals,
						ownerServices,
						options.ownerInteractiveMode,
					);
					startupUICancellation.restore();
					resource.setInputLoop(startProjectionInputLoop(
						mode,
						session,
						(error) => failures.notify(error),
					));
					resolveReady();
					if (!published) {
						published = true;
						publish(resource);
					}
				} catch (error) {
					if (!mode) {
						projectionRuntime.setBeforeSessionInvalidate(undefined);
						projectionRuntime.setRebindSession(undefined);
					}
					try {
						if (initialPresentationApplied) {
							restoreOwnerPresentationOwnership(
								themeInternals,
								ownerServices,
								options.ownerInteractiveMode,
							);
						} else {
							restoreGlobalPresentation(
								globalSnapshot,
								themeInternals,
								ownerServices,
								options.ownerInteractiveMode,
							);
						}
					} catch (restoreError) {
						const aggregate = new AggregateError(
							[error, restoreError],
							"Pi-native projection construction and Owner presentation restoration failed",
						);
						if (published) {
							if (rejectReady(aggregate)) projectionFailures?.notify(aggregate);
						} else {
							if (mode) await disposeMode(mode, projectionRuntime);
							rejectPublication(aggregate);
						}
						return;
					}
					if (published) {
						if (rejectReady(error)) projectionFailures?.notify(error);
					} else {
						if (mode) await disposeMode(mode, projectionRuntime);
						rejectPublication(error);
					}
				}
			}).catch(rejectPublication).finally(finishInitialization);
			return publication;
		},
	});
}

async function serializeProjectionInitialization<T>(
	operation: () => Promise<T>,
): Promise<T> {
	const previous = projectionInitializationTail;
	let release!: () => void;
	projectionInitializationTail = new Promise<void>((resolve) => {
		release = resolve;
	});
	await previous;
	try {
		return await operation();
	} finally {
		release();
	}
}

function installEmbeddedInitializationCancellation(
	mode: ProjectionInteractiveMode,
): Readonly<{ cancel(): void; restore(): void }> {
	let resolveCancellation!: () => void;
	const cancellation = new Promise<undefined>((resolve) => {
		resolveCancellation = () => resolve(undefined);
	});
	let canceled = false;
	const standardMembers = [
		"showExtensionSelector",
		"showExtensionConfirm",
		"showExtensionInput",
		"showExtensionEditor",
	] as const;
	const members = [...standardMembers, "showExtensionCustom"] as const;
	const nativeMethods = new Map<
		(typeof members)[number],
		(...args: unknown[]) => Promise<unknown>
	>();
	for (const member of members) nativeMethods.set(member, mode[member]);
	for (const member of standardMembers) {
		const nativeShow = nativeMethods.get(member)!.bind(mode);
		mode[member] = (...args: unknown[]) => canceled
			? Promise.resolve(undefined)
			: Promise.race([nativeShow(...args), cancellation]);
	}
	const nativeShowCustom = nativeMethods.get("showExtensionCustom")!.bind(mode);
	const closeCustomOperations = new Set<() => void>();
	mode.showExtensionCustom = (factory: unknown, ...args: unknown[]) => {
		if (canceled || typeof factory !== "function") return Promise.resolve(undefined);
		let closeNativeOperation = () => undefined;
		const close = () => closeNativeOperation();
		const wrappedFactory = async (...factoryArgs: unknown[]) => {
			const done = factoryArgs[3];
			if (typeof done === "function") {
				closeNativeOperation = () => done(undefined);
				if (canceled) closeNativeOperation();
			}
			const component = await factory(...factoryArgs);
			if (canceled && component && typeof component === "object") {
				try {
					(component as { dispose?: () => void }).dispose?.();
				} catch {
					// Pi's native custom close also treats component disposal as best effort.
				}
			}
			return component;
		};
		closeCustomOperations.add(close);
		return Promise.race([
			nativeShowCustom(wrappedFactory, ...args),
			cancellation,
		]).finally(() => closeCustomOperations.delete(close));
	};
	return {
		cancel() {
			if (canceled) return;
			canceled = true;
			for (const close of closeCustomOperations) close();
			resolveCancellation();
		},
		restore() {
			for (const member of members) mode[member] = nativeMethods.get(member)!;
		},
	};
}

function installEmbeddedLifecyclePolicy(
	mode: ProjectionInteractiveMode,
	requestOwnerShutdown: () => void,
): void {
	// Embedded modes are Run-owned components, not process owners. Pi's normal
	// signal and shutdown paths call process.exit() and dispose the runtime.
	mode.registerSignalHandlers = () => undefined;
	mode.unregisterSignalHandlers = () => undefined;
	mode.shutdown = async () => {
		mode.shutdownRequested = false;
		requestOwnerShutdown();
	};
	mode.handleFatalRuntimeError = async (prefix, error) => {
		mode.showError(
			`${prefix}: ${error instanceof Error ? error.message : String(error)}`,
		);
	};
}

function installEmbeddedRenderFailurePolicy(
	mode: ProjectionInteractiveMode,
	reportFailure: (error: unknown) => void,
): void {
	const nativeRender = mode.renderer.doRender.bind(mode.renderer);
	mode.renderer.doRender = () => {
		try {
			nativeRender();
		} catch (error) {
			reportFailure(error);
		}
	};
}

function createProjectionResource(
	sessionId: string,
	mode: ProjectionInteractiveMode,
	runtime: AgentSessionRuntime,
	terminal: ProjectionTerminal,
	changes: ProjectionChanges,
	failures: ProjectionFailures,
	exitRequests: ProjectionExitRequests,
	ready: Promise<void>,
	initializationFinished: Promise<void>,
	cancelReady: (error: unknown) => boolean,
	isInitialized: () => boolean,
	readRenderFailure: () => Readonly<{ error: unknown }> | undefined,
): PiNativeAgentProjection & { setInputLoop(loop: ProjectionInputLoop): void } {
	let disposal: Promise<void> | undefined;
	let inputLoop: ProjectionInputLoop | undefined;
	const dispose = () => {
		disposal ??= (async () => {
			// Startup cancellation first settles extension UI, then lets init unwind and
			// restore Owner-global presentation ownership before shutdown tears down mode state.
			await initializationFinished;
			inputLoop?.stop();
			changes.dispose();
			failures.dispose();
			exitRequests.dispose();
			await disposeMode(mode, runtime);
		})();
		return disposal;
	};
	return Object.freeze({
		sessionId,
		presentation: {
			render(width) {
				terminal.resize(width, terminal.rows);
				if (!isInitialized()) return ["Initializing Agent UI…"];
				mode.renderer.renderNow(true);
				const renderFailure = readRenderFailure();
				if (renderFailure) throw renderFailure.error;
				return [...mode.renderer.previousScreen];
			},
			invalidate: () => mode.renderer.invalidate(),
		},
		resize: (columns, rows) => terminal.resize(columns, rows),
		dispatchInput: (data) => terminal.dispatchInput(data),
		addChangeHandler: (handler) => changes.addHandler(handler),
		addFailureHandler: (handler) => failures.addHandler(handler),
		addExitRequestHandler: (handler) => exitRequests.addHandler(handler),
		ready: () => ready,
		cancelInitialization(error) {
			if (!cancelReady(error)) return undefined;
			return initializationFinished;
		},
		setInputLoop(loop) {
			if (disposal) loop.stop();
			else inputLoop = loop;
		},
		dispose,
	});
}

class ProjectionChanges {
	readonly #handlers = new Set<() => void>();
	#disposed = false;

	addHandler(handler: () => void): () => void {
		if (this.#disposed) return () => undefined;
		this.#handlers.add(handler);
		return () => this.#handlers.delete(handler);
	}

	notify(): void {
		if (this.#disposed) return;
		for (const handler of this.#handlers) handler();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#handlers.clear();
	}
}

class ProjectionFailures {
	readonly #handlers = new Set<(error: unknown) => void>();
	#disposed = false;

	addHandler(handler: (error: unknown) => void): () => void {
		if (this.#disposed) return () => undefined;
		this.#handlers.add(handler);
		return () => this.#handlers.delete(handler);
	}

	notify(error: unknown): void {
		if (this.#disposed) return;
		for (const handler of this.#handlers) handler(error);
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#handlers.clear();
	}
}

class ProjectionExitRequests {
	readonly #handlers = new Set<() => void>();
	#disposed = false;

	addHandler(handler: () => void): () => void {
		if (this.#disposed) return () => undefined;
		this.#handlers.add(handler);
		return () => this.#handlers.delete(handler);
	}

	notify(): void {
		if (this.#disposed) return;
		for (const handler of this.#handlers) handler();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#handlers.clear();
	}
}

async function disposeMode(
	mode: ProjectionInteractiveMode,
	runtime: AgentSessionRuntime,
): Promise<void> {
	const cleanupErrors: unknown[] = [];
	const attempt = (cleanup: () => void) => {
		try {
			cleanup();
		} catch (error) {
			cleanupErrors.push(error);
		}
	};
	try {
		const runner = runtime.session.extensionRunner;
		if (runner.hasHandlers("session_shutdown")) {
			await runner.emit({ type: "session_shutdown", reason: "quit" });
		}
	} catch (error) {
		cleanupErrors.push(error);
	}
	attempt(() => mode.themeController.terminalColorSchemeUnsubscribe?.());
	mode.themeController.terminalColorSchemeUnsubscribe = undefined;
	attempt(() => mode.resetExtensionUI());
	attempt(() => mode.stop());
	attempt(() => runtime.setBeforeSessionInvalidate(undefined));
	attempt(() => runtime.setRebindSession(undefined));
	if (cleanupErrors.length > 0) {
		throw new AggregateError(cleanupErrors, "Pi-native projection disposal failed");
	}
}

function captureGlobalPresentation(
	ownerInteractiveMode: unknown,
): GlobalPresentationSnapshot {
	const globals = globalThis as Record<PropertyKey, unknown>;
	const globalTheme = globals[THEME_KEY];
	const globalThemeName = (
		globalTheme && typeof globalTheme === "object"
			? (globalTheme as { name?: unknown }).name
			: undefined
	);
	const ownerMode = ownerInteractiveMode as {
		themeController?: { activeThemeName?: unknown };
	};
	const activeThemeName = ownerMode?.themeController?.activeThemeName;
	return {
		keybindings: getKeybindings(),
		theme: globalTheme,
		activeThemeName: typeof activeThemeName !== "string"
			? undefined
			: activeThemeName === "<in-memory>"
				? activeThemeName
				: typeof globalThemeName === "string" && globalThemeName !== activeThemeName
					? globalThemeName
					: activeThemeName,
	};
}

type ProjectionInputLoop = Readonly<{ stop(): void }>;

function startProjectionInputLoop(
	mode: ProjectionInteractiveMode,
	session: AgentSession,
	reportFailure: (error: unknown) => void,
): ProjectionInputLoop {
	let stopped = false;
	void (async () => {
		while (!stopped) {
			let input: string;
			try {
				input = await mode.getUserInput();
			} catch (error) {
				if (!stopped) reportFailure(error);
				return;
			}
			if (stopped) return;
			try {
				await session.prompt(input);
			} catch (error) {
				mode.showError(
					error instanceof Error ? error.message : "Unknown error occurred",
				);
			}
		}
	})();
	return { stop: () => { stopped = true; } };
}

function restoreGlobalPresentation(
	snapshot: GlobalPresentationSnapshot,
	themeInternals: ThemeInternals,
	ownerServices: AgentSessionServices,
	ownerInteractiveMode: unknown,
): void {
	try {
		themeInternals.onThemeChange(
			createOwnerThemeChangeHandler(ownerInteractiveMode),
		);
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

function restoreOwnerPresentationOwnership(
	themeInternals: ThemeInternals,
	ownerServices: AgentSessionServices,
	ownerInteractiveMode: unknown,
): void {
	themeInternals.onThemeChange(
		createOwnerThemeChangeHandler(ownerInteractiveMode),
	);
	themeInternals.setRegisteredThemes(
		ownerServices.resourceLoader.getThemes().themes,
	);
}

function createOwnerThemeChangeHandler(ownerInteractiveMode: unknown): () => void {
	const ownerMode = ownerInteractiveMode as {
		ui?: { invalidate(): void; requestRender(): void };
		updateEditorBorderColor?(): void;
	} | undefined;
	if (
		!ownerMode?.ui ||
		typeof ownerMode.ui.invalidate !== "function" ||
		typeof ownerMode.ui.requestRender !== "function" ||
		typeof ownerMode.updateEditorBorderColor !== "function"
	) return () => undefined;
	return () => {
		ownerMode.ui!.invalidate();
		ownerMode.updateEditorBorderColor!();
		ownerMode.ui!.requestRender();
	};
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
			"onThemeChange",
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

async function loadFooterDataProviderConstructor(): Promise<FooterDataProviderConstructor> {
	footerDataProviderConstructorPromise ??= import(
		pathToFileURL(
			join(getPackageDir(), "dist", "core", "footer-data-provider.js"),
		).href
	).then((moduleValue: Record<PropertyKey, unknown>) => {
		const constructor = moduleValue.FooterDataProvider as
			| FooterDataProviderConstructor
			| undefined;
		const setupDescriptor = constructor && typeof constructor === "function"
			? Object.getOwnPropertyDescriptor(
				constructor.prototype,
				"setupGitWatcher",
			)
			: undefined;
		if (
			typeof constructor !== "function" ||
			typeof constructor.prototype?.setupGitWatcher !== "function" ||
			setupDescriptor?.writable === false ||
			(setupDescriptor?.set === undefined && setupDescriptor?.value === undefined)
		) {
			throw new IncompatiblePiHostError(
				"FooterDataProvider.prototype.setupGitWatcher",
				VERSION,
			);
		}
		return constructor;
	});
	return footerDataProviderConstructorPromise;
}

function suppressFooterWatcherConstruction(
	FooterDataProvider: FooterDataProviderConstructor,
): () => void {
	const prototype = FooterDataProvider.prototype;
	const setupGitWatcher = prototype.setupGitWatcher;
	prototype.setupGitWatcher = () => undefined;
	return () => {
		prototype.setupGitWatcher = setupGitWatcher;
	};
}

function createProjectionTerminalStateReader(
	ownerInteractiveMode: unknown,
): () => ProjectionTerminalState {
	const ownerTerminal = (
		ownerInteractiveMode as {
			renderer?: { terminal?: Partial<Terminal> };
		} | undefined
	)?.renderer?.terminal;
	return () => ({
		columns: positiveTerminalDimension(
			ownerTerminal?.columns ?? process.stdout.columns,
			FALLBACK_TERMINAL_COLUMNS,
		),
		rows: positiveTerminalDimension(
			ownerTerminal?.rows ?? process.stdout.rows,
			FALLBACK_TERMINAL_ROWS,
		),
		kittyProtocolActive: ownerTerminal?.kittyProtocolActive ?? false,
	});
}

function positiveTerminalDimension(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: fallback;
}

class ProjectionTerminal implements Terminal {
	readonly #readState: () => ProjectionTerminalState;
	#dimensions: Readonly<{ columns: number; rows: number }> | undefined;
	#onInput: ((data: string) => void) | undefined;
	#onResize: (() => void) | undefined;

	constructor(readState: () => ProjectionTerminalState) {
		this.#readState = readState;
	}

	get columns(): number {
		return this.#dimensions?.columns ?? this.#readState().columns;
	}

	get rows(): number {
		return this.#dimensions?.rows ?? this.#readState().rows;
	}

	get kittyProtocolActive(): boolean {
		return this.#readState().kittyProtocolActive;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.#onInput = onInput;
		this.#onResize = onResize;
	}
	stop(): void {
		this.#onInput = undefined;
		this.#onResize = undefined;
	}
	dispatchInput(data: string): void {
		this.#onInput?.(data);
	}
	resize(columns: number, rows: number): void {
		if (!Number.isInteger(columns) || columns <= 0) {
			throw new Error(`Projection terminal columns must be positive: ${columns}`);
		}
		if (!Number.isInteger(rows) || rows <= 0) {
			throw new Error(`Projection terminal rows must be positive: ${rows}`);
		}
		if (
			this.#dimensions?.columns === columns &&
			this.#dimensions.rows === rows
		) return;
		this.#dimensions = { columns, rows };
		this.#onResize?.();
	}
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
