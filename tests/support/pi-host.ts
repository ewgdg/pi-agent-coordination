import {
	createFauxCore,
	fauxAssistantMessage,
	type FauxResponseStep,
} from "@earendil-works/pi-ai";
import {
	AgentSessionRuntime,
	InteractiveMode,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	createAgentSessionFromServices,
	createAgentSessionServices,
	type AgentSession,
	type AgentSessionServices,
	type ExtensionFactory,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
	readonly agentViews: Array<{ title: string; options: string[] }>;
	readonly notifications: Array<{ message: string; type?: "info" | "warning" | "error" }>;
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
};

export async function createTestOwnerHost(
	extension: ExtensionFactory,
	options?: TestOwnerHostOptions,
): Promise<TestOwnerHost> {
	const host = await createUnboundTestOwnerHost(extension, options);
	await bindTestOwnerHost(host, "tui");
	return host;
}

export async function createUnboundTestOwnerHost(
	extension: ExtensionFactory,
	options?: TestOwnerHostOptions,
): Promise<TestOwnerHost> {
	const cwd = await mkdtemp(join(tmpdir(), "pi-agent-coordination-"));
	const additionalExtensionPaths = options?.additionalExtensionPaths ?? [];
	const retainedExtensionPaths = new Set(additionalExtensionPaths);
	const { modelRuntime, faux } = await createTestModelRuntime();
	const model = modelRuntime.getModel(PROVIDER_ID, MODEL_ID);
	if (!model) throw new Error("Deterministic test model was not registered");

	const services = await createAgentSessionServices({
		cwd,
		agentDir: join(cwd, ".pi-agent"),
		modelRuntime,
		settingsManager: SettingsManager.inMemory(),
		resourceLoaderOptions: {
			noContextFiles: true,
			noPromptTemplates: true,
			noSkills: true,
			noThemes: true,
			additionalExtensionPaths,
			extensionFactories: [
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
	const sessionManager = options?.persistent
		? SessionManager.create(cwd, join(cwd, "sessions"))
		: SessionManager.inMemory(cwd);
	const { session } = await createAgentSessionFromServices({
		services,
		sessionManager,
		sessionStartEvent: { type: "session_start", reason: "startup" },
		model,
		thinkingLevel: "off",
		noTools: "builtin",
	});
	const runtime = new AgentSessionRuntime(session, services, async () => {
		throw new Error("Session replacement is outside this test");
	});
	const ui = createTestUi();

	return { cwd, services, session, runtime, ui, model: faux };
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
	const { bindCurrentSessionExtensions } =
		InteractiveMode.prototype as unknown as InteractiveBindingPrototype;
	await bindCurrentSessionExtensions.call(interactiveMode);
}

function createTestUi(): TestUi {
	const agentViews: TestUi["agentViews"] = [];
	const notifications: TestUi["notifications"] = [];
	return {
		agentViews,
		notifications,
		async select(title: string, options: string[]) {
			agentViews.push({ title, options: [...options] });
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
		setStatus() {},
		setWorkingMessage() {},
		setWorkingVisible() {},
		setWorkingIndicator() {},
		setHiddenThinkingLabel() {},
		setWidget() {},
		setFooter() {},
		setHeader() {},
		setTitle() {},
		async custom() {
			throw new Error("Custom TUI is outside this test");
		},
		pasteToEditor() {},
		setEditorText() {},
		getEditorText() {
			return "";
		},
		async editor() {
			return undefined;
		},
		setEditorComponent() {},
	} as unknown as TestUi;
}

async function createTestModelRuntime(): Promise<{
	modelRuntime: ModelRuntime;
	faux: { setResponses(responses: FauxResponseStep[]): void };
}> {
	const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false, modelsPath: null });
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
	modelRuntime.registerProvider(PROVIDER_ID, {
		name: "Coordination test",
		baseUrl: PROVIDER_BASE_URL,
		api: PROVIDER_ID,
		apiKey: "in-memory-test",
		models: faux.models,
		streamSimple: faux.streamSimple,
	});
	return { modelRuntime, faux };
}
