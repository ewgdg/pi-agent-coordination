import assert from "node:assert/strict";
import test from "node:test";

import {
	AgentSessionRuntime,
	type AgentSession,
	type AgentSessionServices,
} from "@earendil-works/pi-coding-agent";

import { captureInteractiveRuntime, getHostPiSdk } from "./runtime-capture.ts";

test("plain Pi startup exposes the runtime when InteractiveMode binds", async () => {
	const runtime = new AgentSessionRuntime(
		{} as AgentSession,
		{ cwd: "/project/owner" } as AgentSessionServices,
		async () => {
			throw new Error("not used");
		},
	);
	const capturedRuntime = captureInteractiveRuntime();

	runtime.setRebindSession(async () => undefined);

	assert.equal(await capturedRuntime, runtime);
});

test("selecting an idle session clears stale working state before async rebinding", async () => {
	const { InteractiveMode } = getHostPiSdk();
	let finishBinding: (() => void) | undefined;
	const binding = new Promise<void>((resolve) => {
		finishBinding = resolve;
	});
	const statusChanges: string[] = [];
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: { session: { isStreaming: false } },
		applyRuntimeSettings() {},
		async bindCurrentSessionExtensions() {
			statusChanges.push("binding-started");
			await binding;
		},
		subscribeToAgent() {},
		async updateAvailableProviderCount() {},
		updateEditorBorderColor() {},
		updateTerminalTitle() {},
		clearStatusIndicator(kind?: "working") {
			statusChanges.push(`cleared-${kind ?? "all"}`);
		},
		setWorkingVisible() {},
	}) as InstanceType<typeof InteractiveMode>;

	const rebinding = (
		mode as unknown as { rebindCurrentSession(): Promise<void> }
	).rebindCurrentSession();
	await Promise.resolve();
	assert.deepEqual(statusChanges, ["cleared-working", "binding-started"]);

	finishBinding?.();
	await rebinding;
});

test("retained session rebind refreshes its extension host without replaying session_start", async () => {
	const { InteractiveMode } = getHostPiSdk();
	const extensionEvents: string[] = [];
	const session = {
		isStreaming: false,
		resourceLoader: {
			getThemes: () => ({ themes: [] }),
		},
		extensionRunner: {},
		async bindExtensions() {
			extensionEvents.push("session_start");
		},
		_applyExtensionBindings() {
			extensionEvents.push("host-refreshed");
		},
	};
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: { session },
		applyRuntimeSettings() {},
		createExtensionUIContext: () => ({}),
		restoreQueuedMessagesToEditor() {},
		setupAutocompleteProvider() {},
		setupExtensionShortcuts() {},
		showLoadedResources() {},
		showStartupNoticesIfNeeded() {},
		subscribeToAgent() {},
		async updateAvailableProviderCount() {},
		updateEditorBorderColor() {},
		updateTerminalTitle() {},
		clearStatusIndicator() {},
		setWorkingVisible() {},
	}) as InstanceType<typeof InteractiveMode>;

	const rebindCurrentSession = (
		mode as unknown as { rebindCurrentSession(): Promise<void> }
	).rebindCurrentSession.bind(mode);
	await rebindCurrentSession();
	await rebindCurrentSession();

	assert.deepEqual(extensionEvents, ["session_start", "host-refreshed"]);
});

test("an idle selected session accepts input while another session remains active", async () => {
	const { InteractiveMode } = getHostPiSdk();
	const startedPrompts: string[] = [];
	const researcher = {
		prompt(text: string) {
			startedPrompts.push(`researcher:${text}`);
			return new Promise<void>(() => undefined);
		},
	};
	const owner = {
		async prompt(text: string) {
			startedPrompts.push(`owner:${text}`);
		},
	};
	const sessions = [researcher, owner];
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		pendingUserInputs: ["research", "owner work"],
		onInputCallback: undefined,
		showError() {},
	}) as InstanceType<typeof InteractiveMode>;
	Object.defineProperty(mode, "session", {
		get: () => sessions[startedPrompts.length] ?? owner,
	});

	void (mode as unknown as { getUserInput(): Promise<string> }).getUserInput();
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();

	assert.deepEqual(startedPrompts, ["researcher:research", "owner:owner work"]);
});
