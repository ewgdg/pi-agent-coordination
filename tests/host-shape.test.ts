import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import * as hostAi from "@earendil-works/pi-ai";
import * as hostPi from "@earendil-works/pi-coding-agent";
import * as hostTui from "@earendil-works/pi-tui";
import * as hostTypebox from "typebox";

import piAgentCoordination from "../src/index.ts";
import {
	assertExtensionApiShape,
	assertHostModuleShape,
	assertInteractiveModeInstanceShape,
	assertProjectionInteractiveModeInstanceShape,
	assertPiAiModuleShape,
	assertRuntimeInstanceShape,
	assertTuiModuleShape,
	assertTypeboxModuleShape,
	IncompatiblePiHostError,
} from "../src/pi-integration/host-shape.ts";
import { installInteractiveHostBridge } from "../src/pi-integration/interactive-host-bridge.ts";
import { bindTestOwnerHost, createUnboundTestOwnerHost } from "./support/pi-host.ts";

type InteractivePrototype = {
	bindCurrentSessionExtensions(): Promise<void>;
};

test("the package declares exactly the Pi host modules imported by production", async () => {
	const manifest = JSON.parse(
		await readFile(new URL("../package.json", import.meta.url), "utf8"),
	) as {
		dependencies?: Record<string, string>;
		peerDependencies?: Record<string, string>;
	};
	const expectedHostPeers = {
		"@earendil-works/pi-agent-core": "*",
		"@earendil-works/pi-ai": "*",
		"@earendil-works/pi-coding-agent": "*",
		"@earendil-works/pi-tui": "*",
		typebox: "*",
	};

	assert.deepEqual(manifest.peerDependencies, expectedHostPeers);
	for (const hostModule of Object.keys(expectedHostPeers)) {
		assert.equal(manifest.dependencies?.[hostModule], undefined);
	}
});

test("host preflight identifies a missing export without installing a patch", () => {
	const fixture = {
		...hostPi,
		createAgentSessionServices: undefined,
	};
	const interactivePrototype = fixture.InteractiveMode
		.prototype as unknown as InteractivePrototype;
	const originalBindCurrentSessionExtensions =
		interactivePrototype.bindCurrentSessionExtensions;

	assert.throws(
		() => installInteractiveHostBridge(fixture),
		(error: unknown) =>
			error instanceof IncompatiblePiHostError &&
			error.memberName === "createAgentSessionServices" &&
			error.message.includes(`running Pi ${hostPi.VERSION}`),
	);
	assert.equal(
		interactivePrototype.bindCurrentSessionExtensions,
		originalBindCurrentSessionExtensions,
	);
});

test("host preflight identifies a malformed private seam by canonical name", () => {
	function MalformedInteractiveMode() {}
	MalformedInteractiveMode.prototype = Object.create(hostPi.InteractiveMode.prototype, {
		getUserInput: { configurable: true, value: undefined },
	});
	const fixture = { ...hostPi, InteractiveMode: MalformedInteractiveMode };

	assert.throws(
		() => assertHostModuleShape(fixture),
		(error: unknown) =>
			error instanceof IncompatiblePiHostError &&
			error.memberName === "InteractiveMode.prototype.getUserInput",
	);
});

test("host preflight covers every host constructor member used after admission", () => {
	const malformedSettingsManager = Object.assign(
		function MalformedSettingsManager() {},
		{ create: undefined },
	);
	assert.throws(
		() => assertHostModuleShape({
			...hostPi,
			SettingsManager: malformedSettingsManager,
		}),
		(error: unknown) =>
			error instanceof IncompatiblePiHostError &&
			error.memberName === "SettingsManager.create",
	);

	for (const member of ["get", "set"] as const) {
		function MalformedProjectTrustStore() {}
		MalformedProjectTrustStore.prototype = Object.create(
			hostPi.ProjectTrustStore.prototype,
			{ [member]: { configurable: true, value: undefined } },
		);
		assert.throws(
			() => assertHostModuleShape({
				...hostPi,
				ProjectTrustStore: MalformedProjectTrustStore,
			}),
			(error: unknown) =>
				error instanceof IncompatiblePiHostError &&
				error.memberName === `ProjectTrustStore.prototype.${member}`,
		);
	}

	assert.throws(
		() => assertHostModuleShape({
			...hostPi,
			CURRENT_SESSION_VERSION: "3",
		}),
		(error: unknown) =>
			error instanceof IncompatiblePiHostError &&
			error.memberName === "CURRENT_SESSION_VERSION",
	);
});

test("module preflight rejects every required host export and prototype seam", () => {
	const requirements = [
		["AgentSessionRuntime"],
		["InteractiveMode"],
		["SessionManager"],
		["DefaultResourceLoader"],
		["ProjectTrustStore"],
		["SettingsManager"],
		["createAgentSessionServices"],
		["createAgentSessionFromServices"],
		["defineTool"],
		["getPackageDir"],
		["hasTrustRequiringProjectResources"],
		["CURRENT_SESSION_VERSION"],
		...[
			"setRebindSession",
			"setBeforeSessionInvalidate",
			"dispose",
		].map((member) => ["AgentSessionRuntime", "prototype", member]),
		...[
			"bindCurrentSessionExtensions",
			"rebindCurrentSession",
			"getUserInput",
			"renderInitialMessages",
			"subscribeToAgent",
			"stop",
		].map((member) => ["InteractiveMode", "prototype", member]),
		...["create", "open", "continueRecent", "inMemory"].map(
			(member) => ["SessionManager", member],
		),
		...[
			"appendCustomEntry",
			"appendCustomMessageEntry",
			"_rewriteFile",
			"getEntries",
			"getEntry",
			"getHeader",
			"getSessionId",
			"getSessionFile",
			"getSessionDir",
			"isPersisted",
			"getLeafId",
			"getCwd",
			"branch",
		].map((member) => ["SessionManager", "prototype", member]),
		...["getExtensions", "getSkills", "reload"].map(
			(member) => ["DefaultResourceLoader", "prototype", member],
		),
		["SettingsManager", "create"],
		...["get", "set"].map(
			(member) => ["ProjectTrustStore", "prototype", member],
		),
	] as const;

	for (const path of requirements) {
		const expected = path.join(".");
		assert.throws(
			() => assertHostModuleShape(
				hostModuleWithoutMember(path),
			),
			(error: unknown) =>
				error instanceof IncompatiblePiHostError &&
				error.memberName === expected,
			expected,
		);
	}
});

test("module preflight rejects every required TUI, AI, and schema value", () => {
	const tuiRequirements = [
		["Text"],
		["getKeybindings"],
		["matchesKey"],
		["setKeybindings"],
		["visibleWidth"],
		["wrapTextWithAnsi"],
		["Key"],
		...["backspace", "down", "enter", "escape", "left", "right", "space", "tab", "up", "shift"]
			.map((member) => ["Key", member]),
	] as const;
	for (const path of tuiRequirements) {
		const expected = `PiTUI.${path.join(".")}`;
		assert.throws(
			() => assertTuiModuleShape(withoutMemberAtPath({ ...hostTui }, path)),
			(error: unknown) =>
				error instanceof IncompatiblePiHostError &&
				error.memberName === expected,
			expected,
		);
	}

	assert.throws(
		() => assertPiAiModuleShape(withoutMemberAtPath(
			{ ...hostAi },
			["createAssistantMessageEventStream"],
		)),
		(error: unknown) =>
			error instanceof IncompatiblePiHostError &&
			error.memberName === "PiAI.createAssistantMessageEventStream",
	);
	for (const path of [
		["Type"],
		...["Array", "Boolean", "Integer", "Literal", "Object", "Optional", "String", "Union"]
			.map((member) => ["Type", member]),
	]) {
		const expected = `TypeBox.${path.join(".")}`;
		assert.throws(
			() => assertTypeboxModuleShape(withoutMemberAtPath({ ...hostTypebox }, path)),
			(error: unknown) =>
				error instanceof IncompatiblePiHostError &&
				error.memberName === expected,
			expected,
		);
	}
});

test("live preflight rejects every required runtime and AgentSession seam", async () => {
	const host = await createUnboundTestOwnerHost(() => undefined);
	host.runtime.setRebindSession(async () => undefined);
	host.runtime.setBeforeSessionInvalidate(() => undefined);
	const requirements = [
		[["_session"], "AgentSessionRuntime._session"],
		[["_services"], "AgentSessionRuntime._services"],
		[["_diagnostics"], "AgentSessionRuntime._diagnostics"],
		[["_modelFallbackMessage"], "AgentSessionRuntime._modelFallbackMessage"],
		[["rebindSession"], "AgentSessionRuntime.rebindSession"],
		[["beforeSessionInvalidate"], "AgentSessionRuntime.beforeSessionInvalidate"],
		[["dispose"], "AgentSessionRuntime.dispose"],
		[["diagnostics"], "AgentSessionRuntime.diagnostics"],
		[["services"], "AgentSessionRuntime.services"],
		[["services", "cwd"], "AgentSessionRuntime.services.cwd"],
		[["services", "agentDir"], "AgentSessionRuntime.services.agentDir"],
		[["services", "modelRuntime"], "AgentSessionRuntime.services.modelRuntime"],
		[["services", "modelRuntime", "getModel"], "AgentSessionRuntime.services.modelRuntime.getModel"],
		[["services", "settingsManager"], "AgentSessionRuntime.services.settingsManager"],
		...[
			"applyOverrides",
			"getDefaultProjectTrust",
			"getProviderRetrySettings",
			"getShowHardwareCursor",
			"getThemeSetting",
			"getTransport",
			"isProjectTrusted",
		].map((member) => [
			["services", "settingsManager", member],
			`AgentSessionRuntime.services.settingsManager.${member}`,
		] as const),
		[["services", "resourceLoader"], "AgentSessionRuntime.services.resourceLoader"],
		[
			["services", "resourceLoader", "extensionFactories"],
			"AgentSessionRuntime.services.resourceLoader.extensionFactories",
		],
		...["getExtensions", "getSkills", "reload"].map((member) => [
			["services", "resourceLoader", member],
			`AgentSessionRuntime.services.resourceLoader.${member}`,
		] as const),
		[["session"], "AgentSession"],
		...[
			"prompt",
			"sendUserMessage",
			"sendCustomMessage",
			"clearQueue",
			"subscribe",
			"bindExtensions",
			"abort",
			"waitForIdle",
			"dispose",
			"getActiveToolNames",
			"getToolDefinition",
		].map((member) => [["session", member], `AgentSession.${member}`] as const),
		...["model", "thinkingLevel", "isIdle", "sessionId", "_extensionUIContext", "_extensionMode", "_extensionCommandContextActions", "_extensionAbortHandler", "_extensionShutdownHandler", "_extensionErrorListener"]
			.map((member) => [["session", member], `AgentSession.${member}`] as const),
		[["session", "_applyExtensionBindings"], "AgentSession._applyExtensionBindings"],
		[["session", "_runAgentPrompt"], "AgentSession._runAgentPrompt"],
		[["session", "extensionRunner"], "AgentSession.extensionRunner"],
		[["session", "sessionManager"], "AgentSession.sessionManager"],
		[["session", "sessionManager", "flushed"], "AgentSession.sessionManager.flushed"],
		[["session", "settingsManager"], "AgentSession.settingsManager"],
		...[
			"applyOverrides",
			"getDefaultProjectTrust",
			"getProviderRetrySettings",
			"getShowHardwareCursor",
			"getThemeSetting",
			"getTransport",
			"isProjectTrusted",
		].map((member) => [
			["session", "settingsManager", member],
			`AgentSession.settingsManager.${member}`,
		] as const),
		[["session", "agent"], "AgentSession.agent"],
		[["session", "agent", "streamFunction"], "AgentSession.agent.streamFunction"],
		[["session", "agent", "transport"], "AgentSession.agent.transport"],
	] as const;

	for (const [path, expected] of requirements) {
		assert.throws(
			() => assertRuntimeInstanceShape(withoutMemberAtPath(host.runtime, path)),
			(error: unknown) =>
				error instanceof IncompatiblePiHostError &&
				error.memberName === expected,
			expected,
		);
	}
	await host.runtime.dispose();
});

test("live preflight validates Pi's private inline extension factory registry", async () => {
	const host = await createUnboundTestOwnerHost(() => undefined);
	host.runtime.setRebindSession(async () => undefined);
	host.runtime.setBeforeSessionInvalidate(() => undefined);
	const loader = host.services.resourceLoader as unknown as {
		extensionFactories: unknown;
	};
	const original = loader.extensionFactories;
	const sparse = new Array(1);
	const malformed = [
		{
			value: {},
			expected: "AgentSessionRuntime.services.resourceLoader.extensionFactories",
		},
		{
			value: sparse,
			expected: "AgentSessionRuntime.services.resourceLoader.extensionFactories[0]",
		},
		{
			value: [null],
			expected: "AgentSessionRuntime.services.resourceLoader.extensionFactories[0]",
		},
		{
			value: [{ name: "", factory() {} }],
			expected: "AgentSessionRuntime.services.resourceLoader.extensionFactories[0].name",
		},
		{
			value: [{ name: "named", factory: undefined }],
			expected: "AgentSessionRuntime.services.resourceLoader.extensionFactories[0].factory",
		},
		{
			value: [{ name: "named", factory() {}, hidden: "yes" }],
			expected: "AgentSessionRuntime.services.resourceLoader.extensionFactories[0].hidden",
		},
	] as const;
	try {
		for (const sample of malformed) {
			loader.extensionFactories = sample.value;
			assert.throws(
				() => assertRuntimeInstanceShape(host.runtime),
				(error: unknown) =>
					error instanceof IncompatiblePiHostError &&
					error.memberName === sample.expected,
				sample.expected,
			);
		}
		for (const accepted of [
			[() => undefined],
			[{ name: "named", factory() {} }],
			[{ name: "hidden", factory() {}, hidden: true }],
			[{ name: "visible", factory() {}, hidden: false }],
		]) {
			loader.extensionFactories = accepted;
			assert.doesNotThrow(() => assertRuntimeInstanceShape(host.runtime));
		}
	} finally {
		loader.extensionFactories = original;
		await host.runtime.dispose();
	}
});

test("live preflight rejects every required InteractiveMode seam", async () => {
	const host = await createUnboundTestOwnerHost(() => undefined);
	const mode = {
		runtimeHost: host.runtime,
		ui: { requestRender() {} },
		bindCurrentSessionExtensions() {},
		rebindCurrentSession() {},
		getUserInput() {},
		setWorkingVisible() {},
		clearStatusIndicator() {},
		showError() {},
	};
	const requirements = [
		[["runtimeHost"], "InteractiveMode.runtimeHost"],
		[["runtimeHost", "session"], "InteractiveMode.runtimeHost.session"],
		[["ui"], "InteractiveMode.ui"],
		[["ui", "requestRender"], "InteractiveMode.ui.requestRender"],
		...["bindCurrentSessionExtensions", "rebindCurrentSession", "getUserInput", "setWorkingVisible", "clearStatusIndicator", "showError"]
			.map((member) => [[member], `InteractiveMode.${member}`] as const),
	] as const;
	for (const [path, expected] of requirements) {
		assert.throws(
			() => assertInteractiveModeInstanceShape(withoutMemberAtPath(mode, path)),
			(error: unknown) =>
				error instanceof IncompatiblePiHostError &&
				error.memberName === expected,
			expected,
		);
	}
	await host.runtime.dispose();
});

test("live preflight rejects every projection-owned InteractiveMode seam", async () => {
	const host = await createUnboundTestOwnerHost(() => undefined);
	const component = { render: () => [], invalidate() {} };
	const mode = {
		chatContainer: component,
		statusContainer: component,
		footerDataProvider: { dispose() {} },
		isInitialized: false,
		renderer: { terminal: {} },
		themeController: {},
		renderInitialMessages() {},
		subscribeToAgent() {},
		stop() {},
	};
	const requirements = [
		[["chatContainer"], "InteractiveMode.chatContainer"],
		[["chatContainer", "render"], "InteractiveMode.chatContainer.render"],
		[["chatContainer", "invalidate"], "InteractiveMode.chatContainer.invalidate"],
		[["statusContainer"], "InteractiveMode.statusContainer"],
		[["statusContainer", "render"], "InteractiveMode.statusContainer.render"],
		[["statusContainer", "invalidate"], "InteractiveMode.statusContainer.invalidate"],
		[["footerDataProvider"], "InteractiveMode.footerDataProvider"],
		[["footerDataProvider", "dispose"], "InteractiveMode.footerDataProvider.dispose"],
		[["isInitialized"], "InteractiveMode.isInitialized"],
		[["renderer"], "InteractiveMode.renderer"],
		[["renderer", "terminal"], "InteractiveMode.renderer.terminal"],
		[["themeController"], "InteractiveMode.themeController"],
		[["renderInitialMessages"], "InteractiveMode.renderInitialMessages"],
		[["subscribeToAgent"], "InteractiveMode.subscribeToAgent"],
		[["stop"], "InteractiveMode.stop"],
	] as const;
	for (const [path, expected] of requirements) {
		assert.throws(
			() => assertProjectionInteractiveModeInstanceShape(withoutMemberAtPath(mode, path)),
			(error: unknown) =>
				error instanceof IncompatiblePiHostError && error.memberName === expected,
			expected,
		);
	}
	for (const [path, expected] of [
		[["isInitialized"], "InteractiveMode.isInitialized"],
		[["renderer", "terminal"], "InteractiveMode.renderer.terminal"],
	] as const) {
		assert.throws(
			() => assertProjectionInteractiveModeInstanceShape(
				readonlyMemberAtPath(mode, path),
			),
			(error: unknown) =>
				error instanceof IncompatiblePiHostError && error.memberName === expected,
			expected,
		);
	}
	await host.runtime.dispose();
});

test("preflight rejects read-only integration targets that coordination mutates", async () => {
	for (const [path, expected] of [
		[["AgentSessionRuntime", "prototype", "dispose"], "AgentSessionRuntime.prototype.dispose"],
		[["InteractiveMode", "prototype", "bindCurrentSessionExtensions"], "InteractiveMode.prototype.bindCurrentSessionExtensions"],
	] as const) {
		assert.throws(
			() => assertHostModuleShape(hostModuleWithReadonlyMember(path)),
			(error: unknown) =>
				error instanceof IncompatiblePiHostError &&
				error.memberName === expected,
			expected,
		);
	}

	const host = await createUnboundTestOwnerHost(() => undefined);
	host.runtime.setRebindSession(async () => undefined);
	host.runtime.setBeforeSessionInvalidate(() => undefined);
	for (const [path, expected] of [
		[["_session"], "AgentSessionRuntime._session"],
		[["_services"], "AgentSessionRuntime._services"],
		[["_diagnostics"], "AgentSessionRuntime._diagnostics"],
		[["_modelFallbackMessage"], "AgentSessionRuntime._modelFallbackMessage"],
		[["dispose"], "AgentSessionRuntime.dispose"],
		[["session", "bindExtensions"], "AgentSession.bindExtensions"],
		[["session", "_runAgentPrompt"], "AgentSession._runAgentPrompt"],
		[["session", "_extensionUIContext"], "AgentSession._extensionUIContext"],
		[["session", "_extensionMode"], "AgentSession._extensionMode"],
		[["session", "_extensionCommandContextActions"], "AgentSession._extensionCommandContextActions"],
		[["session", "_extensionAbortHandler"], "AgentSession._extensionAbortHandler"],
		[["session", "_extensionShutdownHandler"], "AgentSession._extensionShutdownHandler"],
		[["session", "_extensionErrorListener"], "AgentSession._extensionErrorListener"],
		[["session", "agent", "streamFunction"], "AgentSession.agent.streamFunction"],
		[["session", "agent", "transport"], "AgentSession.agent.transport"],
	] as const) {
		assert.throws(
			() => assertRuntimeInstanceShape(readonlyMemberAtPath(host.runtime, path)),
			(error: unknown) =>
				error instanceof IncompatiblePiHostError &&
				error.memberName === expected,
			expected,
		);
	}
	await host.runtime.dispose();
});

test("extension preflight rejects every required registration seam", () => {
	const api = {
		on() {},
		registerTool() {},
		registerCommand() {},
		appendEntry() {},
	};
	for (const member of ["on", "registerTool", "registerCommand", "appendEntry"] as const) {
		assert.throws(
			() => assertExtensionApiShape(withoutMemberAtPath(api, [member])),
			(error: unknown) =>
				error instanceof IncompatiblePiHostError &&
				error.memberName === `ExtensionAPI.${member}`,
		);
	}
});

test("host preflight validates every running-host TUI value used by presentation", () => {
	const fixture = { ...hostTui, wrapTextWithAnsi: undefined };

	assert.throws(
		() => assertTuiModuleShape(fixture, hostPi.VERSION),
		(error: unknown) =>
			error instanceof IncompatiblePiHostError &&
			error.memberName === "PiTUI.wrapTextWithAnsi" &&
			error.message.includes(`running Pi ${hostPi.VERSION}`),
	);
});

test("host preflight validates running-host AI and schema values", () => {
	assert.throws(
		() => assertPiAiModuleShape(
			{ ...hostAi, createAssistantMessageEventStream: undefined },
			hostPi.VERSION,
		),
		(error: unknown) =>
			error instanceof IncompatiblePiHostError &&
			error.memberName === "PiAI.createAssistantMessageEventStream",
	);
	assert.throws(
		() => assertTypeboxModuleShape(
			{ ...hostTypebox, Type: { ...hostTypebox.Type, Object: undefined } },
			hostPi.VERSION,
		),
		(error: unknown) =>
			error instanceof IncompatiblePiHostError &&
			error.memberName === "TypeBox.Type.Object",
	);
});

test("host bridge installation remains idempotent across extension and host module reload", async () => {
	installInteractiveHostBridge(hostPi);
	const interactivePrototype = hostPi.InteractiveMode
		.prototype as unknown as InteractivePrototype;
	const installedBindCurrentSessionExtensions =
		interactivePrototype.bindCurrentSessionExtensions;
	const reloadedModuleUrl = new URL(
		"../src/pi-integration/interactive-host-bridge.ts",
		import.meta.url,
	);
	reloadedModuleUrl.searchParams.set("reload", "regression");
	const reloadedBridgeModule = (await import(reloadedModuleUrl.href)) as typeof import(
		"../src/pi-integration/interactive-host-bridge.ts"
	);

	// Pi's reload loader recreates the host module namespace while reusing the
	// running host constructors and their prototypes.
	reloadedBridgeModule.installInteractiveHostBridge({ ...hostPi });

	assert.equal(
		interactivePrototype.bindCurrentSessionExtensions,
		installedBindCurrentSessionExtensions,
	);
});

test("runtime capture rejects a malformed live AgentSession before bootstrap", async () => {
	const host = await createUnboundTestOwnerHost(piAgentCoordination);
	const interactivePrototype = hostPi.InteractiveMode
		.prototype as unknown as InteractivePrototype;
	const installedCapture = interactivePrototype.bindCurrentSessionExtensions;
	const originalSendCustomMessage = host.session.sendCustomMessage;
	Object.defineProperty(host.session, "sendCustomMessage", {
		configurable: true,
		value: undefined,
	});
	host.runtime.setBeforeSessionInvalidate(() => undefined);

	await assert.rejects(
		() => bindTestOwnerHost(host, "tui"),
		(error: unknown) =>
			error instanceof IncompatiblePiHostError &&
			error.memberName === "AgentSession.sendCustomMessage",
	);
	assert.equal(
		host.session.sessionManager
			.getEntries()
			.some(
				(entry) =>
					entry.type === "custom" && entry.customType === "agent-coordination.identity",
			),
		false,
	);
	assert.notEqual(
		interactivePrototype.bindCurrentSessionExtensions,
		installedCapture,
		"failed live admission must restore the native host prototype",
	);
	Object.defineProperty(host.session, "sendCustomMessage", {
		configurable: true,
		value: originalSendCustomMessage,
	});
	await host.runtime.dispose();
});

test("runtime capture rejects a malformed inline factory registry before Owner bootstrap", async () => {
	const host = await createUnboundTestOwnerHost(piAgentCoordination);
	const loader = host.services.resourceLoader as unknown as {
		extensionFactories: unknown;
	};
	const original = loader.extensionFactories;
	loader.extensionFactories = [{ name: "broken", factory: undefined }];
	host.runtime.setBeforeSessionInvalidate(() => undefined);

	await assert.rejects(
		() => bindTestOwnerHost(host, "tui"),
		(error: unknown) =>
			error instanceof IncompatiblePiHostError &&
			error.memberName ===
				"AgentSessionRuntime.services.resourceLoader.extensionFactories[0].factory",
	);
	assert.equal(
		host.session.sessionManager.getEntries().some(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === "agent-coordination.identity",
		),
		false,
	);
	assert.equal(host.session.getToolDefinition("agent_spawn"), undefined);
	loader.extensionFactories = original;
	await host.runtime.dispose();
});

test("runtime capture identifies the coordinated settings override seam", async () => {
	const host = await createUnboundTestOwnerHost(piAgentCoordination);
	const settings = host.services.settingsManager as unknown as Record<PropertyKey, unknown>;
	const originalApplyOverrides = settings.applyOverrides;
	settings.applyOverrides = undefined;
	host.runtime.setBeforeSessionInvalidate(() => undefined);

	await assert.rejects(
		() => bindTestOwnerHost(host, "tui"),
		(error: unknown) =>
			error instanceof IncompatiblePiHostError &&
			error.memberName === "AgentSessionRuntime.services.settingsManager.applyOverrides",
	);
	settings.applyOverrides = originalApplyOverrides;
	await host.runtime.dispose();
});

test("runtime capture rejects transport incompatibility before Owner bootstrap", async () => {
	const host = await createUnboundTestOwnerHost(piAgentCoordination);
	const settings = host.services.settingsManager as unknown as Record<PropertyKey, unknown>;
	const originalGetTransport = settings.getTransport;
	settings.getTransport = undefined;
	host.runtime.setBeforeSessionInvalidate(() => undefined);

	await assert.rejects(
		() => bindTestOwnerHost(host, "tui"),
		(error: unknown) =>
			error instanceof IncompatiblePiHostError &&
			error.memberName === "AgentSessionRuntime.services.settingsManager.getTransport",
	);
	assert.equal(
		host.session.sessionManager
			.getEntries()
			.some(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === "agent-coordination.identity",
			),
		false,
	);
	settings.getTransport = originalGetTransport;
	await host.runtime.dispose();
});

test("runtime capture identifies the provider stream adapter seam", async () => {
	const host = await createUnboundTestOwnerHost(piAgentCoordination);
	const agent = host.session.agent as unknown as Record<PropertyKey, unknown>;
	const originalStreamFunction = agent.streamFunction;
	agent.streamFunction = undefined;
	host.runtime.setBeforeSessionInvalidate(() => undefined);

	await assert.rejects(
		() => bindTestOwnerHost(host, "tui"),
		(error: unknown) =>
			error instanceof IncompatiblePiHostError &&
			error.memberName === "AgentSession.agent.streamFunction",
	);
	agent.streamFunction = originalStreamFunction;
	await host.runtime.dispose();
});

function withoutMemberAtPath<T extends object>(
	target: T,
	path: readonly PropertyKey[],
): T {
	const [member, ...rest] = path;
	assert.notEqual(member, undefined);
	return new Proxy(target, {
		get(original, key) {
			if (key !== member) return Reflect.get(original, key, original);
			if (rest.length === 0) return undefined;
			const nested = Reflect.get(original, key, original);
			assert.ok((typeof nested === "object" && nested !== null) || typeof nested === "function");
			return withoutMemberAtPath(nested as object, rest);
		},
		has(original, key) {
			if (key === member && rest.length === 0) return false;
			return Reflect.has(original, key);
		},
	}) as T;
}

function hostModuleWithoutMember(path: readonly PropertyKey[]): object {
	const fixture = { ...hostPi } as Record<PropertyKey, unknown>;
	if (path.length >= 3 && path[1] === "prototype") {
		const constructorName = path[0]!;
		const original = fixture[constructorName] as { prototype: object };
		function MalformedHostConstructor() {}
		Object.setPrototypeOf(MalformedHostConstructor, original);
		MalformedHostConstructor.prototype = withoutMemberAtPath(
			original.prototype,
			path.slice(2),
		);
		fixture[constructorName] = MalformedHostConstructor;
		return fixture;
	}
	return withoutMemberAtPath(fixture, path);
}

function hostModuleWithReadonlyMember(path: readonly PropertyKey[]): object {
	const fixture = { ...hostPi } as Record<PropertyKey, unknown>;
	if (path.length >= 3 && path[1] === "prototype") {
		const constructorName = path[0]!;
		const original = fixture[constructorName] as { prototype: object };
		function ReadonlyHostConstructor() {}
		Object.setPrototypeOf(ReadonlyHostConstructor, original);
		ReadonlyHostConstructor.prototype = readonlyMemberAtPath(
			original.prototype,
			path.slice(2),
		);
		fixture[constructorName] = ReadonlyHostConstructor;
		return fixture;
	}
	return readonlyMemberAtPath(fixture, path);
}

function readonlyMemberAtPath<T extends object>(
	target: T,
	path: readonly PropertyKey[],
): T {
	const [member, ...rest] = path;
	assert.notEqual(member, undefined);
	return new Proxy(target, {
		get(original, key) {
			const value = Reflect.get(original, key, original);
			if (key !== member || rest.length === 0) return value;
			assert.ok((typeof value === "object" && value !== null) || typeof value === "function");
			return readonlyMemberAtPath(value as object, rest);
		},
		getOwnPropertyDescriptor(original, key) {
			if (key === member && rest.length === 0) {
				return {
					configurable: true,
					enumerable: true,
					value: Reflect.get(original, key, original),
					writable: false,
				};
			}
			return Reflect.getOwnPropertyDescriptor(original, key);
		},
	}) as T;
}
