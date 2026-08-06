import {
	createFauxCore,
	fauxAssistantMessage,
	type FauxResponseStep,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import {
	AgentSessionRuntime,
	InteractiveMode,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	createAgentSessionFromServices,
	createAgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
	type AgentSession,
	type AgentSessionServices,
	type ExtensionFactory,
	type InlineExtension,
	type ExtensionUIContext,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type {
	Component,
	OverlayHandle,
	TUI,
} from "@earendil-works/pi-tui";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPiBuiltInExtensionFactories } from "../../src/pi-integration/named-inline-extension-factories.ts";

const PROVIDER_ID = "coordination-test";
const MODEL_ID = "deterministic-owner";
const PROVIDER_BASE_URL = "http://coordination-test.invalid";

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
} as const;

export type TestUi = ExtensionUIContext & {
	readonly genericSelectCalls: Array<{ title: string; options: string[] }>;
	readonly notifications: Array<{ message: string; type?: "info" | "warning" | "error" }>;
	readonly customSurfaces: Component[];
	readonly statuses: Map<string, string>;
	readonly widgets: Map<string, readonly string[]>;
};

export type TestOwnerHost = {
	cwd: string;
	services: AgentSessionServices;
	session: AgentSession;
	runtime: AgentSessionRuntime;
	ui: TestUi;
	model: {
		setResponses(responses: FauxResponseStep[]): void;
	};
};

export type TestOwnerHostOptions = {
	persistent?: boolean;
	additionalExtensionPaths?: string[];
	additionalExtensionFactories?: InlineExtension[];
	cwd?: string;
	agentDir?: string;
	sessionFile?: string;
	implicitModeratorResponses?: boolean;
	settings?: Parameters<typeof SettingsManager.inMemory>[0];
};

export async function createTestOwnerHost(
	extension: ExtensionFactory,
	options?: TestOwnerHostOptions,
): Promise<TestOwnerHost> {
	const host = await createUnboundTestOwnerHost(extension, options);
	await bindTestOwnerHost(host, "tui");
	return host;
}

export async function createPiCliTestOwnerHost(
	extension: ExtensionFactory,
	options?: TestOwnerHostOptions,
): Promise<TestOwnerHost> {
	const host = await createUnboundTestOwnerHostWithRuntime(
		extension,
		options,
		await loadPiBuiltInExtensionFactories(),
		true,
	);
	await bindTestOwnerHost(host, "tui");
	return host;
}

export async function createUnboundTestOwnerHost(
	extension: ExtensionFactory,
	options?: TestOwnerHostOptions,
): Promise<TestOwnerHost> {
	return createUnboundTestOwnerHostWithRuntime(extension, options, [], false);
}

async function createUnboundTestOwnerHostWithRuntime(
	extension: ExtensionFactory,
	options: TestOwnerHostOptions | undefined,
	piBuiltInExtensionFactories: readonly InlineExtension[],
	allowModelNetwork: boolean,
): Promise<TestOwnerHost> {
	const cwd = options?.cwd ?? await mkdtemp(join(tmpdir(), "pi-agent-coordination-"));
	const agentDir = options?.agentDir ?? join(cwd, ".pi-agent");
	const additionalExtensionPaths = options?.additionalExtensionPaths ?? [];
	const additionalExtensionFactories = options?.additionalExtensionFactories ?? [];
	const retainedExtensionPaths = new Set(additionalExtensionPaths);
	const { modelRuntime, faux } = await createTestModelRuntime({
		implicitModeratorResponses: options?.implicitModeratorResponses ?? true,
		allowModelNetwork,
	});
	const sessionManager = options?.sessionFile
		? SessionManager.open(options.sessionFile)
		: options?.persistent
			? SessionManager.create(cwd, join(cwd, "sessions"))
			: SessionManager.inMemory(cwd);
	const createRuntime: CreateAgentSessionRuntimeFactory = async (runtimeOptions) => {
		const services = await createAgentSessionServices({
			cwd: runtimeOptions.cwd,
			agentDir: runtimeOptions.agentDir,
			modelRuntime,
			settingsManager: SettingsManager.inMemory(options?.settings),
			resourceLoaderOptions: {
				noContextFiles: true,
				noPromptTemplates: true,
				noSkills: true,
				noThemes: true,
				additionalExtensionPaths,
				extensionFactories: [
					...piBuiltInExtensionFactories,
					...additionalExtensionFactories,
					{
						name: "pi-agent-coordination",
						hidden: false,
						factory: extension,
					},
				],
				extensionsOverride: (loaded) => ({
					...loaded,
					extensions: loaded.extensions.filter(
						(candidate) =>
							candidate.path.startsWith("<inline:") ||
							retainedExtensionPaths.has(candidate.resolvedPath),
					),
				}),
			},
		});
		const model = modelRuntime.getModel(PROVIDER_ID, MODEL_ID);
		if (!model) throw new Error("Deterministic test model was not registered");
		const created = await createAgentSessionFromServices({
			services,
			sessionManager: runtimeOptions.sessionManager,
			sessionStartEvent: runtimeOptions.sessionStartEvent,
			model,
			thinkingLevel: "off",
			noTools: "builtin",
		});
		return {
			...created,
			services,
			diagnostics: [...services.diagnostics],
		};
	};
	const initial = await createRuntime({
		cwd,
		agentDir,
		sessionManager,
		sessionStartEvent: { type: "session_start", reason: "startup" },
	});
	const runtime = new AgentSessionRuntime(
		initial.session,
		initial.services,
		createRuntime,
		initial.diagnostics,
		initial.modelFallbackMessage,
	);
	const ui = createTestUi();

	return {
		cwd,
		services: initial.services,
		session: initial.session,
		runtime,
		ui,
		model: faux,
	};
}

export async function bindTestOwnerHost(
	host: TestOwnerHost,
	mode: "tui" | "rpc" | "json" | "print",
): Promise<void> {
	if (mode === "tui") {
		// InteractiveMode installs these callbacks before it binds extensions. Using
		// the real runtime here preserves that observable startup order without a TTY.
		host.runtime.setBeforeSessionInvalidate(() => undefined);
		host.runtime.setRebindSession(async () => undefined);
		await bindInteractiveTestHost(host);
		return;
	}
	await host.session.bindExtensions({
		uiContext: host.ui,
		mode,
		onError: (error) => host.ui.notify(error.error, "error"),
	});
}

async function bindInteractiveTestHost(host: TestOwnerHost): Promise<void> {
	type InteractiveBindingHarness = {
		runtimeHost: AgentSessionRuntime;
		ui: { requestRender(): void };
		createExtensionUIContext(): ExtensionUIContext;
		setupAutocompleteProvider(): void;
		setupExtensionShortcuts(): void;
		showLoadedResources(): void;
		showStartupNoticesIfNeeded(): void;
		showExtensionError(_extensionPath: string, error: string): void;
	};
	type InteractiveBindingPrototype = {
		bindCurrentSessionExtensions(this: InteractiveBindingHarness): Promise<void>;
	};

	// Exercise Pi's real TUI-only binding seam without starting a terminal. The
	// post-bind rendering hooks are irrelevant to extension startup in this harness.
	const interactiveMode = Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: host.runtime,
		ui: { requestRender() {} },
		createExtensionUIContext: () => host.ui,
		setupAutocompleteProvider() {},
		setupExtensionShortcuts() {},
		showLoadedResources() {},
		showStartupNoticesIfNeeded() {},
		showExtensionError(_extensionPath: string, error: string) {
			host.ui.notify(error, "error");
		},
	}) as InteractiveBindingHarness;
	const bindCurrentSessionExtensions = () => {
		const binding = InteractiveMode.prototype as unknown as InteractiveBindingPrototype;
		return binding.bindCurrentSessionExtensions.call(interactiveMode);
	};
	host.runtime.setRebindSession(bindCurrentSessionExtensions);
	await bindCurrentSessionExtensions();
}

function createTestUi(): TestUi {
	const genericSelectCalls: TestUi["genericSelectCalls"] = [];
	const notifications: TestUi["notifications"] = [];
	const customSurfaces: Component[] = [];
	const statuses: TestUi["statuses"] = new Map();
	const widgets: TestUi["widgets"] = new Map();
	let editorText = "";
	const testTui = {
		terminal: { columns: 80, rows: 24 },
		requestRender() {},
	} as unknown as TUI;
	const testTheme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;
	const custom: ExtensionUIContext["custom"] = <T>(factory: (
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: (result: T) => void,
	) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>, options?: {
		overlay?: boolean;
		overlayOptions?: Parameters<TUI["showOverlay"]>[1] | (() => Parameters<TUI["showOverlay"]>[1]);
		onHandle?: (handle: OverlayHandle) => void;
	}) => {
		return new Promise<T>((resolve, reject) => {
			let component: (Component & { dispose?(): void }) | undefined;
			let finished = false;
			const done = (result: T) => {
				if (finished) return;
				finished = true;
				if (component) {
					const index = customSurfaces.indexOf(component);
					if (index >= 0) customSurfaces.splice(index, 1);
					component.dispose?.();
				}
				resolve(result);
			};
			Promise.resolve(
				factory(
					testTui,
					testTheme,
					{} as KeybindingsManager,
					done,
				),
			).then((created) => {
				component = created;
				customSurfaces.push(created);
				options?.onHandle?.(createTestOverlayHandle());
			}, reject);
		});
	};
	return {
		genericSelectCalls,
		notifications,
		customSurfaces,
		statuses,
		widgets,
		async select(title: string, options: string[]) {
			genericSelectCalls.push({ title, options: [...options] });
			return undefined;
		},
		async confirm() {
			return false;
		},
		async input() {
			return undefined;
		},
		notify(message: string, type?: "info" | "warning" | "error") {
			notifications.push({ message, type });
		},
		onTerminalInput() {
			return () => undefined;
		},
		setStatus(key: string, value: string | undefined) {
			if (value === undefined) statuses.delete(key);
			else statuses.set(key, value);
		},
		setWorkingMessage() {},
		setWorkingVisible() {},
		setWorkingIndicator() {},
		setHiddenThinkingLabel() {},
		setWidget(key: string, value: readonly string[] | undefined) {
			if (value === undefined) widgets.delete(key);
			else widgets.set(key, value);
		},
		setFooter() {},
		setHeader() {},
		setTitle() {},
		custom,
		pasteToEditor() {},
		setEditorText(text: string) {
			editorText = text;
		},
		getEditorText() {
			return editorText;
		},
		async editor() {
			return undefined;
		},
		setEditorComponent() {},
		theme: testTheme,
	} as unknown as TestUi;
}

function createTestOverlayHandle(): OverlayHandle {
	let hidden = false;
	let focused = true;
	return {
		hide() {
			hidden = true;
			focused = false;
		},
		setHidden(value) {
			hidden = value;
		},
		isHidden() {
			return hidden;
		},
		focus() {
			focused = true;
			hidden = false;
		},
		unfocus() {
			focused = false;
		},
		isFocused() {
			return focused;
		},
	};
}

async function createTestModelRuntime(options: {
	implicitModeratorResponses: boolean;
	allowModelNetwork: boolean;
}): Promise<{
	modelRuntime: ModelRuntime;
	faux: { setResponses(responses: FauxResponseStep[]): void };
}> {
	const modelRuntime = await ModelRuntime.create({
		allowModelNetwork: options.allowModelNetwork,
		modelsPath: null,
	});
	const faux = createFauxCore({
		api: PROVIDER_ID,
		provider: PROVIDER_ID,
		models: [
			{
				id: MODEL_ID,
				name: "Deterministic Owner",
				reasoning: false,
				input: ["text"],
				cost: EMPTY_USAGE.cost,
				contextWindow: 16_384,
				maxTokens: 256,
			},
		],
	});
	faux.setResponses([fauxAssistantMessage("Owner interaction preserved.")]);
	const maybeImplicitModeratorResponse = (
		model: Model<string>,
		context: Context,
		streamOptions: StreamOptions | SimpleStreamOptions | undefined,
	) => {
		if (
			!options.implicitModeratorResponses ||
			!isImplicitModeratorRequest(context)
		) return undefined;
		const implicit = createFauxCore({
			api: PROVIDER_ID,
			provider: PROVIDER_ID,
			models: [
				{
					id: MODEL_ID,
					name: "Deterministic Owner",
					reasoning: false,
					input: ["text"],
					cost: EMPTY_USAGE.cost,
					contextWindow: 16_384,
					maxTokens: 256,
				},
			],
		});
		implicit.setResponses([fauxAssistantMessage("I will wait for explicit Moderator work.")]);
		return implicit.streamSimple(model, context, streamOptions);
	};
	modelRuntime.registerProvider(PROVIDER_ID, {
		name: "Coordination test",
		baseUrl: PROVIDER_BASE_URL,
		api: PROVIDER_ID,
		apiKey: "in-memory-test",
		models: faux.models,
		streamSimple: (model, context, streamOptions) =>
			maybeImplicitModeratorResponse(model, context, streamOptions) ??
			faux.streamSimple(model, context, streamOptions),
	});
	return { modelRuntime, faux };
}

function isImplicitModeratorRequest(context: Context): boolean {
	return (
		context.tools?.some(({ name }) => name === "moderator_control") === true &&
		context.messages.some((message) =>
			message.role === "user" &&
			Array.isArray(message.content) &&
			message.content.some(
				(part) =>
					part.type === "text" &&
					part.text.includes('"kind":"obligation_stall"'),
			)
		)
	);
}
