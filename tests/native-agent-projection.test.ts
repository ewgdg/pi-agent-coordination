import assert from "node:assert/strict";
import test from "node:test";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
	CustomEditor,
	InteractiveMode,
	SessionManager,
	createAgentSessionFromServices,
	createAgentSessionServices,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import {
	getKeybindings,
	KeybindingsManager,
	setKeybindings,
	stripTerminalSequences,
	Text,
	type Terminal,
	TUI_KEYBINDINGS,
	visibleWidth,
} from "@earendil-works/pi-tui";

import { IncompatiblePiHostError } from "../src/pi-integration/host-shape.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import { DefaultChildSessionFactory } from "../src/runtime/default-child-session-factory.ts";
import {
	createPiNativeProjectionHost,
} from "../src/pi-integration/native-agent-projection.ts";
import {
	createTestOwnerHost,
	createUnboundTestOwnerHost,
} from "./support/pi-host.ts";

const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
const RENDER_WIDTH = 80;

class InitiallyThrowingProjectionEditor extends CustomEditor {
	override render(_width: number): string[] {
		throw new Error("deterministic initial native render failure");
	}
}

class InertReferenceTerminal implements Terminal {
	columns = 120;
	rows = 60;
	kittyProtocolActive = false;
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

function renderText(component: { render(width: number): string[] }): string {
	return stripTerminalSequences(component.render(RENDER_WIDTH).join("\n"));
}

function currentThemeName(): string | undefined {
	const theme = (globalThis as Record<PropertyKey, unknown>)[THEME_KEY];
	if (!theme || typeof theme !== "object") return undefined;
	const name = (theme as { name?: unknown }).name;
	return typeof name === "string" ? name : undefined;
}

test("a real live InteractiveMode projection reconstructs transcript and follows Run status events", async () => {
	let sessionShutdowns = 0;
	const host = await createTestOwnerHost(() => undefined, {
		persistent: true,
		additionalExtensionFactories: [{
			name: "projection-shutdown-probe",
			factory: (pi) => {
				pi.on("session_shutdown", () => {
					sessionShutdowns += 1;
				});
			},
		}],
	});
	initTheme("dark");
	const projectionHost = createPiNativeProjectionHost({
		ownerRuntime: host.runtime,
		ownerInteractiveMode: {
			themeController: { activeThemeName: "<in-memory>" },
		},
	});
	const ownerSession = host.runtime.session;
	const ownerServices = host.runtime.services;
	const mutableOwnerRuntime = host.runtime as unknown as {
		rebindSession: unknown;
		beforeSessionInvalidate: unknown;
	};
	const ownerRebindSession = mutableOwnerRuntime.rebindSession;
	const ownerBeforeSessionInvalidate = mutableOwnerRuntime.beforeSessionInvalidate;
	const ownerKeybindings = getKeybindings();
	const ownerTheme = (globalThis as Record<PropertyKey, unknown>)[THEME_KEY];
	const processListenerCounts = {
		SIGTERM: process.listenerCount("SIGTERM"),
		SIGHUP: process.listenerCount("SIGHUP"),
		uncaughtException: process.listenerCount("uncaughtException"),
	};
	let releaseResponse!: () => void;
	const responseGate = new Promise<void>((resolve) => {
		releaseResponse = resolve;
	});
	let markResponseStarted!: () => void;
	const responseStarted = new Promise<void>((resolve) => {
		markResponseStarted = resolve;
	});
	host.model.setResponses([
		async () => {
			markResponseStarted();
			await responseGate;
			return fauxAssistantMessage("Projection received the complete live response.");
		},
	]);

	const projection = await projectionHost.createProjection({
		session: ownerSession,
		services: ownerServices,
	});
	assert.equal(host.runtime.session, ownerSession);
	assert.equal(host.runtime.services, ownerServices);
	assert.equal(mutableOwnerRuntime.rebindSession, ownerRebindSession);
	assert.equal(
		mutableOwnerRuntime.beforeSessionInvalidate,
		ownerBeforeSessionInvalidate,
	);
	assert.equal(getKeybindings(), ownerKeybindings);
	assert.equal((globalThis as Record<PropertyKey, unknown>)[THEME_KEY], ownerTheme);
	assert.deepEqual(
		{
			SIGTERM: process.listenerCount("SIGTERM"),
			SIGHUP: process.listenerCount("SIGHUP"),
			uncaughtException: process.listenerCount("uncaughtException"),
		},
		processListenerCounts,
	);
	let projectionChanges = 0;
	let ownerShutdownRequests = 0;
	const removeChangeHandler = projection.addChangeHandler(() => {
		projectionChanges += 1;
	});
	const removeExitRequestHandler = projection.addExitRequestHandler(() => {
		ownerShutdownRequests += 1;
	});

	const prompt = ownerSession.prompt("Render this live transcript through Pi.");
	await responseStarted;
	await waitForCondition(() => renderText(projection.presentation).includes("Working"));
	assert.ok(projectionChanges > 0);
	assert.match(renderText(projection.presentation), /Render this live transcript through Pi/);

	releaseResponse();
	await prompt;
	await ownerSession.waitForIdle();
	await waitForCondition(() =>
		renderText(projection.presentation).includes("Projection received the complete live response.")
	);
	assert.equal(renderText(projection.presentation).includes("Working"), false);
	const changesAtSettlement = projectionChanges;
	assert.ok(changesAtSettlement > 0);
	for (const character of "/quit") projection.dispatchInput(character);
	projection.dispatchInput("\r");
	await waitForCondition(() => ownerShutdownRequests === 1);
	projection.dispatchInput("\x04");
	await waitForCondition(() => ownerShutdownRequests === 2);
	projection.dispatchInput("\x03");
	projection.dispatchInput("\x03");
	await waitForCondition(() => ownerShutdownRequests === 3);
	assert.equal(host.runtime.session, ownerSession);
	removeChangeHandler();
	removeExitRequestHandler();
	await projection.dispose();
	await projection.dispose();
	assert.equal(sessionShutdowns, 1);
	assert.equal(host.runtime.session, ownerSession);
	assert.equal(host.runtime.services, ownerServices);
	assert.equal(mutableOwnerRuntime.rebindSession, ownerRebindSession);
	assert.equal(
		mutableOwnerRuntime.beforeSessionInvalidate,
		ownerBeforeSessionInvalidate,
	);
	assert.equal(getKeybindings(), ownerKeybindings);
	assert.equal((globalThis as Record<PropertyKey, unknown>)[THEME_KEY], ownerTheme);
	await host.runtime.dispose();
});

test("a rejected native input acquisition is reported through the projection failure seam", async () => {
	const host = await createTestOwnerHost(() => undefined, { persistent: true });
	const projectionHost = createPiNativeProjectionHost({ ownerRuntime: host.runtime });
	const prototype = InteractiveMode.prototype as unknown as {
		getUserInput(): Promise<string>;
	};
	const nativeGetUserInput = prototype.getUserInput;
	prototype.getUserInput = async () => {
		throw new Error("deterministic native input acquisition failure");
	};
	let projection: Awaited<ReturnType<typeof projectionHost.createProjection>> | undefined;
	try {
		projection = await projectionHost.createProjection({
			session: host.session,
			services: host.services,
			exposeWhileInitializing: true,
		});
		const failures: unknown[] = [];
		projection.addFailureHandler((error) => failures.push(error));
		await projection.ready();
		await waitForCondition(() => failures.length > 0);
		assert.deepEqual(failures.map(String), [
			"Error: deterministic native input acquisition failure",
		]);
	} finally {
		prototype.getUserInput = nativeGetUserInput;
		await projection?.dispose();
		await host.runtime.dispose();
	}
});

test("retained child rendering preserves newer shared theme and keybinding configuration", async () => {
	const host = await createTestOwnerHost(() => undefined, { persistent: true });
	initTheme("dark");
	const originalKeybindings = getKeybindings();
	const projection = await createPiNativeProjectionHost({
		ownerRuntime: host.runtime,
	}).createProjection({
		session: host.session,
		services: host.services,
	});
	const updatedKeybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
		"tui.altScreen.top": "ctrl+t",
	});
	try {
		setKeybindings(updatedKeybindings);
		initTheme("light");
		const updatedTheme = (globalThis as Record<PropertyKey, unknown>)[THEME_KEY];

		host.session.extensionRunner.createContext().ui.setStatus(
			"shared-state-render-trigger",
			"trigger retained child requestRender",
		);
		assert.equal(getKeybindings(), updatedKeybindings);
		assert.equal((globalThis as Record<PropertyKey, unknown>)[THEME_KEY], updatedTheme);
	} finally {
		setKeybindings(originalKeybindings);
		initTheme("dark");
		await projection.dispose();
		await host.runtime.dispose();
	}
});

test("an explicit session_start theme change remains Workflow-global", async () => {
	initTheme("dark");
	const host = await createTestOwnerHost(() => undefined, {
		persistent: true,
		additionalExtensionFactories: [{
			name: "startup-theme-probe",
			hidden: true,
			factory(pi) {
				pi.on("session_start", (_event, ctx) => {
					const result = ctx.ui.setTheme("light");
					assert.equal(result.success, true);
				});
			},
		}],
	});
	const projection = await createPiNativeProjectionHost({
		ownerRuntime: host.runtime,
	}).createProjection({
		session: host.session,
		services: host.services,
	});

	assert.equal(currentThemeName(), "light");
	projection.resize(80, 24);
	projection.presentation.render(80);
	assert.equal(currentThemeName(), "light");

	await projection.dispose();
	await host.runtime.dispose();
	initTheme("dark");
});

test("a shared theme change remains active while child startup is paused", async () => {
	initTheme("dark");
	const host = await createTestOwnerHost(() => undefined, {
		persistent: true,
		additionalExtensionFactories: [{
			name: "paused-startup-theme-probe",
			hidden: true,
			factory(pi) {
				pi.on("session_start", async (_event, ctx) => {
					await ctx.ui.confirm(
						"Paused child startup",
						"Change the shared theme before continuing.",
					);
				});
			},
		}],
	});
	const projection = await createPiNativeProjectionHost({
		ownerRuntime: host.runtime,
	}).createProjection({
		session: host.session,
		services: host.services,
		exposeWhileInitializing: true,
	});
	projection.resize(80, 24);
	await waitForCondition(() =>
		renderText(projection.presentation).includes("Paused child startup")
	);

	initTheme("light");
	projection.dispatchInput("\r");
	await projection.ready();
	assert.equal(currentThemeName(), "light");
	projection.presentation.render(80);
	assert.equal(currentThemeName(), "light");

	await projection.dispose();
	await host.runtime.dispose();
	initTheme("dark");
});

test("initial native render failure rejects readiness before projection admission", async () => {
	const host = await createTestOwnerHost(() => undefined, {
		persistent: true,
		additionalExtensionFactories: [{
			name: "initial-native-render-failure",
			hidden: true,
			factory(pi) {
				pi.on("session_start", (_event, ctx) => {
					ctx.ui.setEditorComponent((tui, theme, keybindings) =>
						new InitiallyThrowingProjectionEditor(tui, theme, keybindings)
					);
				});
			},
		}],
	});
	const projection = await createPiNativeProjectionHost({
		ownerRuntime: host.runtime,
	}).createProjection({
		session: host.session,
		services: host.services,
		exposeWhileInitializing: true,
	});
	await assert.rejects(
		() => projection.ready(),
		/deterministic initial native render failure/,
	);
	await projection.dispose();
	await host.runtime.dispose();
});

test("repeated real projection lifetimes return process and extension resources to baseline", async () => {
	let sessionStarts = 0;
	let sessionShutdowns = 0;
	const host = await createTestOwnerHost(() => undefined, {
		persistent: true,
		additionalExtensionFactories: [{
			name: "repeated-projection-resource-probe",
			hidden: true,
			factory(pi) {
				pi.on("session_start", () => {
					sessionStarts += 1;
				});
				pi.on("session_shutdown", () => {
					sessionShutdowns += 1;
				});
			},
		}],
	});
	initTheme("dark");
	const projectionHost = createPiNativeProjectionHost({ ownerRuntime: host.runtime });
	const ownerKeybindings = getKeybindings();
	const ownerTheme = (globalThis as Record<PropertyKey, unknown>)[THEME_KEY];
	const processListenerCounts = () => ({
		SIGTERM: process.listenerCount("SIGTERM"),
		SIGHUP: process.listenerCount("SIGHUP"),
		uncaughtException: process.listenerCount("uncaughtException"),
	});
	const baselineListeners = processListenerCounts();
	const baselineStarts = sessionStarts;
	const baselineShutdowns = sessionShutdowns;

	for (let iteration = 0; iteration < 5; iteration += 1) {
		const created = await createAgentSessionFromServices({
			services: host.services,
			sessionManager: SessionManager.inMemory(host.cwd),
			model: host.session.model,
			noTools: "all",
		});
		const projection = await projectionHost.createProjection({
			session: created.session,
			services: host.services,
		});
		await projection.dispose();
		await projection.dispose();
		created.session.dispose();
		assert.deepEqual(processListenerCounts(), baselineListeners);
		assert.equal(getKeybindings(), ownerKeybindings);
		assert.equal((globalThis as Record<PropertyKey, unknown>)[THEME_KEY], ownerTheme);
	}
	assert.equal(sessionStarts - baselineStarts, 5);
	assert.equal(sessionShutdowns - baselineShutdowns, 5);

	await host.runtime.dispose();
});

test("native child shortcuts and command autocomplete remain functional", async () => {
	const host = await createTestOwnerHost(() => undefined, {
		persistent: true,
		additionalExtensionFactories: [{
			name: "native-input-feature-probe",
			hidden: true,
			factory(pi) {
				pi.registerShortcut("alt+q", {
					description: "Render a child-local shortcut marker",
					handler(ctx) {
						ctx.ui.setWidget("native-shortcut-probe", [
							"Native child shortcut invoked",
						]);
					},
				});
				pi.registerCommand("native-completion-probe", {
					description: "Autocomplete this child-local command",
					async handler() {},
				});
			},
		}],
	});
	const projection = await createPiNativeProjectionHost({
		ownerRuntime: host.runtime,
	}).createProjection({
		session: host.session,
		services: host.services,
	});
	projection.resize(80, 24);
	projection.dispatchInput("\x1bq");
	await waitForCondition(() =>
		renderText(projection.presentation).includes("Native child shortcut invoked")
	);
	for (const character of "/native-completion-p") {
		projection.dispatchInput(character);
	}
	projection.dispatchInput("\t");
	await waitForCondition(() =>
		renderText(projection.presentation).includes("native-completion-probe")
	);

	await projection.dispose();
	await host.runtime.dispose();
});

test("two retained child modes preserve independent drafts and overlays", async () => {
	const host = await createTestOwnerHost(() => undefined, {
		persistent: true,
		additionalExtensionFactories: [{
			name: "retained-mode-state-probe",
			hidden: true,
			factory(pi) {
				pi.on("session_start", (_event, ctx) => {
					const identity = ctx.sessionManager.getSessionId();
					ctx.ui.setFooter(() => new Text(`Retained footer · ${identity}`, 0, 0));
					ctx.ui.setStatus("retained-mode", `Retained status · ${identity}`);
				});
				pi.registerCommand("retained-overlay", {
					description: "Open state owned by this exact retained mode",
					async handler(_args, ctx) {
						const identity = ctx.sessionManager.getSessionId();
						ctx.ui.setEditorText(`Retained draft · ${identity}`);
						await ctx.ui.custom<void>(
							(_tui, _theme, _keybindings, done) => ({
								render: () => [`Retained overlay · ${identity}`],
								invalidate() {},
								handleInput(data) {
									if (data === "\x1b") done();
								},
							}),
							{ overlay: true },
						);
					},
				});
			},
		}],
	});
	const projectionHost = createPiNativeProjectionHost({ ownerRuntime: host.runtime });
	const createdSessions = await Promise.all([0, 1].map(async () =>
		createAgentSessionFromServices({
			services: host.services,
			sessionManager: SessionManager.inMemory(host.cwd),
			model: host.session.model,
			noTools: "all",
		})
	));
	for (const [index, created] of createdSessions.entries()) {
		created.session.sessionManager.appendMessage(
			fauxAssistantMessage(
				fauxToolCall(`retained_pending_tool_${index}`, { index }, {
					id: `retained-pending-tool-${index}`,
				}),
				{ stopReason: "toolUse" },
			),
		);
	}
	const projections: Array<Awaited<
		ReturnType<typeof projectionHost.createProjection>
	>> = [];
	for (const created of createdSessions) {
		projections.push(await projectionHost.createProjection({
			session: created.session,
			services: host.services,
		}));
	}
	for (const projection of projections) {
		projection.resize(80, 24);
		for (const character of "/retained-overlay") projection.dispatchInput(character);
		projection.dispatchInput("\r");
	}
	await waitForCondition(() => projections.every((projection, index) =>
		renderText(projection.presentation).includes(
			`Retained overlay · ${createdSessions[index]!.session.sessionId}`,
		)
	));
	for (const [index, projection] of projections.entries()) {
		const ownId = createdSessions[index]!.session.sessionId;
		const otherId = createdSessions[index === 0 ? 1 : 0]!.session.sessionId;
		const frame = renderText(projection.presentation);
		assert.match(frame, new RegExp(`Retained overlay · ${ownId}`));
		assert.doesNotMatch(frame, new RegExp(`Retained overlay · ${otherId}`));
	}

	projections[0]!.dispatchInput("\x1b");
	await waitForCondition(() =>
		renderText(projections[0]!.presentation).includes(
			`Retained draft · ${createdSessions[0]!.session.sessionId}`,
		)
	);
	assert.match(
		renderText(projections[1]!.presentation),
		new RegExp(`Retained overlay · ${createdSessions[1]!.session.sessionId}`),
	);
	projections[1]!.dispatchInput("\x1b");
	await waitForCondition(() =>
		renderText(projections[1]!.presentation).includes(
			`Retained draft · ${createdSessions[1]!.session.sessionId}`,
		)
	);
	for (const [index, projection] of projections.entries()) {
		const frame = renderText(projection.presentation);
		assert.match(frame, new RegExp(`retained_pending_tool_${index}`));
		assert.doesNotMatch(frame, new RegExp(`retained_pending_tool_${index === 0 ? 1 : 0}`));
	}
	const emit = (index: number, event: unknown) => (
		createdSessions[index]!.session as unknown as { _emit(event: unknown): void }
	)._emit(event);
	emit(0, {
		type: "auto_retry_start",
		attempt: 1,
		maxAttempts: 2,
		delayMs: 60_000,
		errorMessage: "retained retry",
	});
	emit(1, { type: "compaction_start", reason: "manual" });
	await waitForCondition(() =>
		/retry/i.test(renderText(projections[0]!.presentation)) &&
		/compact/i.test(renderText(projections[1]!.presentation))
	);
	assert.doesNotMatch(renderText(projections[0]!.presentation), /compacting/i);
	assert.doesNotMatch(renderText(projections[1]!.presentation), /retrying/i);
	emit(0, { type: "auto_retry_end", success: true, attempt: 1 });
	emit(1, {
		type: "compaction_end",
		reason: "manual",
		result: undefined,
		aborted: false,
		willRetry: false,
	});

	for (const projection of projections) await projection.dispose();
	for (const created of createdSessions) created.session.dispose();
	await host.runtime.dispose();
});

test("the complete child renderer keeps a fullscreen transcript viewport and editable dock", async () => {
	const host = await createTestOwnerHost(() => undefined, { persistent: true });
	initTheme("dark");
	for (let index = 0; index < 40; index += 1) {
		host.session.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `Long transcript prompt ${index}` }],
			timestamp: Date.now(),
		});
		host.session.sessionManager.appendMessage(
			fauxAssistantMessage(`Long transcript response ${index}`),
		);
	}
	const projection = await createPiNativeProjectionHost({
		ownerRuntime: host.runtime,
	}).createProjection({
		session: host.session,
		services: host.runtime.services,
	});
	projection.resize(RENDER_WIDTH, 12);

	const tailFrame = renderText(projection.presentation);
	assert.equal(projection.presentation.render(RENDER_WIDTH).length, 12);
	assert.match(tailFrame, /Long transcript response 39/);

	for (let notch = 0; notch < 4; notch += 1) {
		projection.dispatchInput("\x1b[<64;10;5M");
	}
	const inspectedFrame = renderText(projection.presentation);
	assert.match(inspectedFrame, /Long transcript response 3[0-8]/);
	assert.doesNotMatch(inspectedFrame, /Long transcript response 39/);
	for (const character of "editable while inspecting") {
		projection.dispatchInput(character);
	}
	assert.match(renderText(projection.presentation), /editable while inspecting/);
	for (const { width, rows } of [
		{ width: 48, rows: 10 },
		{ width: 100, rows: 18 },
	]) {
		projection.resize(width, rows);
		const resizedFrame = projection.presentation.render(width);
		assert.equal(resizedFrame.length, rows);
		assert.ok(resizedFrame.every((line) => visibleWidth(line) <= width));
		assert.match(
			stripTerminalSequences(resizedFrame.join("\n")),
			/editable while inspecting/,
		);
	}

	projection.focusEditor();
	assert.match(
		stripTerminalSequences(projection.presentation.render(100).join("\n")),
		/Long transcript response 39/,
	);
	projection.dispatchInput("\x1b[5~");
	assert.doesNotMatch(
		stripTerminalSequences(projection.presentation.render(100).join("\n")),
		/Long transcript response 39/,
	);
	projection.dispatchInput("\x1b[6~");
	projection.dispatchInput("\x1b[F");
	assert.match(
		stripTerminalSequences(projection.presentation.render(100).join("\n")),
		/Long transcript response 39/,
	);
	await projection.dispose();
	await host.runtime.dispose();
});

test("streaming follows at the tail and preserves the inspected transcript anchor", async () => {
	let customEditorEscapes = 0;
	const host = await createTestOwnerHost(() => undefined, {
		persistent: true,
		fauxTokensPerSecond: 400,
		additionalExtensionFactories: [{
			name: "streaming-custom-editor-probe",
			hidden: true,
			factory(pi) {
				pi.on("session_start", (_event, ctx) => {
					ctx.ui.setEditorComponent((tui, theme, keybindings) =>
						new class extends CustomEditor {
							override handleInput(data: string): void {
								if (data === "\x1b") {
									customEditorEscapes += 1;
									return;
								}
								super.handleInput(data);
							}
						}(tui, theme, keybindings)
					);
				});
			},
		}],
	});
	for (let index = 0; index < 40; index += 1) {
		host.session.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `Anchor transcript prompt ${index}` }],
			timestamp: Date.now(),
		});
		host.session.sessionManager.appendMessage(
			fauxAssistantMessage(`Anchor transcript response ${index}`),
		);
	}
	const projection = await createPiNativeProjectionHost({
		ownerRuntime: host.runtime,
	}).createProjection({
		session: host.session,
		services: host.services,
	});
	projection.resize(80, 12);
	host.model.setResponses([
		fauxAssistantMessage(
			Array.from(
				{ length: 50 },
				(_value, index) => `Streaming anchor update ${String(index).padStart(2, "0")}`,
			).join("\n"),
		),
	]);
	const streaming = host.session.prompt("Append a deliberately chunked streaming response.");
	await waitForCondition(() => {
		const frame = renderText(projection.presentation);
		return frame.includes("Working") && frame.includes("Streaming anchor update");
	});
	for (let notch = 0; notch < 8; notch += 1) {
		projection.dispatchInput("\x1b[<64;10;5M");
	}
	const inspected = renderText(projection.presentation);
	const anchor = /Anchor transcript (?:prompt|response) \d+/.exec(inspected)?.[0];
	assert.ok(anchor, inspected);
	for (const character of "editable during streaming") {
		projection.dispatchInput(character);
	}
	await new Promise<void>((resolve) => setTimeout(resolve, 100));
	const laterPartial = renderText(projection.presentation);
	assert.match(laterPartial, new RegExp(anchor));
	assert.match(laterPartial, /editable during streaming/);
	projection.resize(48, 14);
	const resizedPartial = stripTerminalSequences(
		projection.presentation.render(48).join("\n"),
	);
	assert.match(resizedPartial, new RegExp(anchor));
	assert.match(resizedPartial, /editable during streaming/);
	projection.dispatchInput("\x1b");
	assert.equal(customEditorEscapes, 1);
	assert.match(
		stripTerminalSequences(projection.presentation.render(48).join("\n")),
		/editable during streaming/,
	);
	projection.resize(80, 12);

	await streaming;
	await host.session.waitForIdle();
	const settledAwayFromTail = renderText(projection.presentation);
	assert.match(settledAwayFromTail, new RegExp(anchor));
	assert.doesNotMatch(settledAwayFromTail, /Streaming anchor update 49/);
	projection.dispatchInput("\x1b[F");
	assert.match(renderText(projection.presentation), /Streaming anchor update 49/);

	await projection.dispose();
	await host.runtime.dispose();
});

test("the native child renderer presents retry and compaction transitions", async () => {
	const host = await createTestOwnerHost(() => undefined, { persistent: true });
	const projection = await createPiNativeProjectionHost({
		ownerRuntime: host.runtime,
	}).createProjection({
		session: host.session,
		services: host.services,
	});
	projection.resize(80, 24);
	const emit = (event: unknown) => (
		host.session as unknown as { _emit(event: unknown): void }
	)._emit(event);

	emit({
		type: "auto_retry_start",
		attempt: 1,
		maxAttempts: 3,
		delayMs: 60_000,
		errorMessage: "deterministic retry transition",
	});
	await waitForCondition(() => /retry/i.test(renderText(projection.presentation)));
	for (const character of "editor remains active during retry") {
		projection.dispatchInput(character);
	}
	assert.match(renderText(projection.presentation), /editor remains active during retry/);
	emit({ type: "auto_retry_end", success: true, attempt: 1 });
	await waitForCondition(() => !/retrying/i.test(renderText(projection.presentation)));

	emit({ type: "compaction_start", reason: "manual" });
	await waitForCondition(() => /compact/i.test(renderText(projection.presentation)));
	assert.match(renderText(projection.presentation), /editor remains active during retry/);
	emit({
		type: "compaction_end",
		reason: "manual",
		result: undefined,
		aborted: false,
		willRetry: false,
	});
	await waitForCondition(() => !/compacting/i.test(renderText(projection.presentation)));

	await projection.dispose();
	await host.runtime.dispose();
});

test("the native projection renders rich transcript and extension entry types together", async () => {
	const host = await createTestOwnerHost(() => undefined, {
		persistent: true,
		additionalExtensionFactories: [{
			name: "native-render-parity-probe",
			hidden: true,
			factory(pi) {
				pi.registerMessageRenderer("render-parity-message", () =>
					new Text("Rendered custom Message parity", 0, 0)
				);
				pi.registerEntryRenderer("render-parity-entry", () =>
					new Text("Rendered custom entry parity", 0, 0)
				);
			},
		}],
	});
	host.session.sessionManager.appendMessage({
		role: "user",
		content: [{
			type: "text",
			text: [
				"# Markdown parity heading",
				"",
				"**bold parity text**",
				"",
				"```mermaid",
				"graph TD",
				"  A --> B",
				"```",
			].join("\n"),
		}],
		timestamp: Date.now(),
	});
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("render_parity_tool", { target: "native frame" }, {
				id: "render-parity-tool-call",
			}),
			{ stopReason: "toolUse" },
		),
	);
	host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: "render-parity-tool-call",
		toolName: "render_parity_tool",
		content: [{ type: "text", text: "Completed tool parity result" }],
		isError: false,
		timestamp: Date.now(),
	});
	host.session.sessionManager.appendCustomMessageEntry(
		"render-parity-message",
		"custom Message source",
		true,
	);
	host.session.sessionManager.appendCustomEntry("render-parity-entry", {
		kind: "native parity",
	});
	const projection = await createPiNativeProjectionHost({
		ownerRuntime: host.runtime,
	}).createProjection({
		session: host.session,
		services: host.services,
	});
	projection.resize(120, 60);
	const frame = stripTerminalSequences(
		projection.presentation.render(120).join("\n"),
	);
	for (const expected of [
		"Markdown parity heading",
		"bold parity text",
		"│ A │",
		"│ B │",
		"render_parity_tool",
		"Completed tool parity result",
		"Rendered custom Message parity",
		"Rendered custom entry parity",
	]) assert.match(frame, new RegExp(expected));

	await projection.dispose();
	await host.runtime.dispose();
});

test("embedded projection lines match a separately initialized native fullscreen mode", async () => {
	const host = await createUnboundTestOwnerHost(() => undefined, {
		persistent: true,
		additionalExtensionFactories: [{
			name: "differential-renderer-probe",
			hidden: true,
			factory(pi) {
				pi.registerMessageRenderer("differential-message", () =>
					new Text("Differential custom Message", 0, 0)
				);
				pi.registerEntryRenderer("differential-entry", () =>
					new Text("Differential custom entry", 0, 0)
				);
			},
		}],
	});
	host.session.sessionManager.appendMessage({
		role: "user",
		content: [{
			type: "text",
			text: [
				"# Differential native parity",
				"",
				"```mermaid",
				"graph LR",
				"  Left --> Right",
				"```",
			].join("\n"),
		}],
		timestamp: Date.now(),
	});
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("pending_differential_tool", { parity: "pending" }, {
				id: "pending-differential-tool-call",
			}),
			{ stopReason: "toolUse" },
		),
	);
	host.session.sessionManager.appendCustomMessageEntry(
		"differential-message",
		"differential custom Message source",
		true,
	);
	host.session.sessionManager.appendCustomEntry("differential-entry", {
		parity: "custom entry",
	});
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("differential_tool", { parity: true }, {
				id: "differential-tool-call",
			}),
			{ stopReason: "toolUse" },
		),
	);
	host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: "differential-tool-call",
		toolName: "differential_tool",
		content: [{ type: "text", text: "Differential tool completed" }],
		isError: false,
		timestamp: Date.now(),
	});
	initTheme("dark");
	const referenceMode = new InteractiveMode(host.runtime, {
		migratedProviders: [],
		initialImages: [],
		initialMessages: [],
		verbose: false,
		tuiMode: "fullscreen",
	});
	const referenceInternals = referenceMode as unknown as {
		renderer: {
			terminal: Terminal;
			previousScreen: string[];
			renderNow(force?: boolean): void;
		};
	};
	referenceInternals.renderer.terminal = new InertReferenceTerminal();
	await referenceMode.init();
	referenceInternals.renderer.renderNow(true);
	const referenceLines = referenceInternals.renderer.previousScreen.map((line) =>
		stripTerminalSequences(line)
	);
	referenceMode.stop();

	const projection = await createPiNativeProjectionHost({
		ownerRuntime: host.runtime,
	}).createProjection({
		session: host.session,
		services: host.services,
	});
	projection.resize(120, 60);
	const projectionLines = projection.presentation.render(120).map((line) =>
		stripTerminalSequences(line)
	);
	assert.deepEqual(projectionLines, referenceLines);

	await projection.dispose();
	await host.runtime.dispose();
});

test("constructor input failure creates no footer watcher or partial runtime binding", async () => {
	const host = await createTestOwnerHost(() => undefined, {
		persistent: true,
		cwd: process.cwd(),
	});
	initTheme("dark");
	const baselineFSEventWraps = process.getActiveResourcesInfo()
		.filter((resource) => resource === "FSEventWrap").length;
	const ownerTheme = (globalThis as Record<PropertyKey, unknown>)[THEME_KEY];
	const ownerKeybindings = getKeybindings();
	const mutableRuntime = host.runtime as unknown as {
		beforeSessionInvalidate: unknown;
		rebindSession: unknown;
	};
	const ownerBeforeSessionInvalidate = mutableRuntime.beforeSessionInvalidate;
	const ownerRebindSession = mutableRuntime.rebindSession;
	const resourceLoader = host.services.resourceLoader as unknown as {
		getThemes: () => unknown;
	};
	const nativeGetThemes = resourceLoader.getThemes;
	resourceLoader.getThemes = () => {
		throw new Error("deterministic constructor theme resource failure");
	};
	try {
		await assert.rejects(
			() => createPiNativeProjectionHost({
				ownerRuntime: host.runtime,
			}).createProjection({
				session: host.session,
				services: host.services,
			}),
			(error: unknown) =>
				error instanceof AggregateError &&
				error.errors.some((cause) =>
					String(cause).includes("deterministic constructor theme resource failure")
				),
		);
	} finally {
		resourceLoader.getThemes = nativeGetThemes;
	}
	assert.equal(
		process.getActiveResourcesInfo()
			.filter((resource) => resource === "FSEventWrap").length,
		baselineFSEventWraps,
	);
	assert.equal(mutableRuntime.beforeSessionInvalidate, ownerBeforeSessionInvalidate);
	assert.equal(mutableRuntime.rebindSession, ownerRebindSession);
	assert.equal((globalThis as Record<PropertyKey, unknown>)[THEME_KEY], ownerTheme);
	assert.equal(getKeybindings(), ownerKeybindings);
	const recoveredProjection = await createPiNativeProjectionHost({
		ownerRuntime: host.runtime,
	}).createProjection({
		session: host.session,
		services: host.services,
	});
	assert.ok(
		process.getActiveResourcesInfo()
			.filter((resource) => resource === "FSEventWrap").length > baselineFSEventWraps,
		"successful construction did not start the deferred footer watcher",
	);
	await recoveredProjection.dispose();
	await waitForCondition(() =>
		process.getActiveResourcesInfo()
			.filter((resource) => resource === "FSEventWrap").length === baselineFSEventWraps
	);

	await host.runtime.dispose();
});

test("projection compatibility failure restores Owner globals before subscribing", async () => {
	const host = await createTestOwnerHost(() => undefined, { persistent: true });
	initTheme("dark");
	const ownerKeybindings = getKeybindings();
	const ownerTheme = (globalThis as Record<PropertyKey, unknown>)[THEME_KEY];
	const projectionHost = createPiNativeProjectionHost({
		ownerRuntime: host.runtime,
		ownerInteractiveMode: {
			themeController: { activeThemeName: "<in-memory>" },
		},
	});
	const prototype = InteractiveMode.prototype as unknown as {
		subscribeToAgent: unknown;
	};
	const nativeSubscribeToAgent = prototype.subscribeToAgent;
	const nativeSubscribe = host.session.subscribe;
	let projectionSubscriptions = 0;
	host.session.subscribe = ((listener) => {
		projectionSubscriptions += 1;
		return nativeSubscribe.call(host.session, listener);
	}) as typeof host.session.subscribe;
	prototype.subscribeToAgent = undefined;
	try {
		await assert.rejects(
			() => projectionHost.createProjection({
				session: host.session,
				services: host.services,
			}),
			(error: unknown) =>
				error instanceof IncompatiblePiHostError &&
				error.memberName === "InteractiveMode.subscribeToAgent",
		);
	} finally {
		prototype.subscribeToAgent = nativeSubscribeToAgent;
		host.session.subscribe = nativeSubscribe;
	}
	assert.equal(projectionSubscriptions, 0);
	assert.equal(getKeybindings(), ownerKeybindings);
	assert.equal((globalThis as Record<PropertyKey, unknown>)[THEME_KEY], ownerTheme);
	await host.runtime.dispose();
});

test("session_start model work begins only after the live projection is subscribed", async () => {
	const host = await createTestOwnerHost(() => undefined, { persistent: true });
	const ownerIdentity = adoptOrValidateOwnerIdentity(
		host.runtime,
		"<inline:pi-agent-coordination>",
	);
	const factory = new DefaultChildSessionFactory({
		ownerRuntime: host.runtime,
		ownerIdentity,
		entryModulePath: "<inline:pi-agent-coordination>",
		packageRoot: host.cwd,
		childExtensionFactory: () => () => undefined,
		moderatorExtensionFactory: () => () => undefined,
		activityExtensionFactory: () => () => undefined,
	});
	let markResponseStarted!: () => void;
	const responseStarted = new Promise<void>((resolve) => {
		markResponseStarted = resolve;
	});
	let releaseResponse!: () => void;
	const responseGate = new Promise<void>((resolve) => {
		releaseResponse = resolve;
	});
	host.model.setResponses([
		async () => {
			markResponseStarted();
			await responseGate;
			return fauxAssistantMessage("Child startup model work completed.");
		},
	]);
	const model = host.session.model;
	assert.ok(model);
	const childServices = await createAgentSessionServices({
		cwd: host.cwd,
		agentDir: host.services.agentDir,
		modelRuntime: host.services.modelRuntime,
		settingsManager: host.services.settingsManager,
		resourceLoaderOptions: {
			noContextFiles: true,
			noPromptTemplates: true,
			noSkills: true,
			noThemes: true,
			extensionFactories: [{
				name: "session-start-model-work-probe",
				hidden: true,
				factory(pi) {
					pi.on("session_start", () => {
						pi.sendUserMessage("Model work emitted by child session_start.");
					});
				},
			}],
		},
	});
	const startedRun = await factory.startSession({
		sessionManager: SessionManager.inMemory(host.cwd),
		prepared: {
			services: childServices,
			configuration: {
				cwd: host.cwd,
				model: { provider: model.provider, modelId: model.id },
				thinking: "off",
				tools: [],
				skills: [],
				extensions: [],
			},
		},
	});
	await responseStarted;
	const statusDuringStartupWork = renderText(startedRun.projection.presentation);

	releaseResponse();
	await startedRun.session.waitForIdle();
	await startedRun.projection.dispose();
	startedRun.session.dispose();
	await host.runtime.dispose();
	assert.match(statusDuringStartupWork, /Working/);
});

test("projection construction failure disposes a partially started real Run session once", async () => {
	const host = await createTestOwnerHost(() => undefined, { persistent: true });
	const ownerIdentity = adoptOrValidateOwnerIdentity(
		host.runtime,
		"<inline:pi-agent-coordination>",
	);
	let childSessionDisposals = 0;
	const factory = new DefaultChildSessionFactory({
		ownerRuntime: host.runtime,
		ownerIdentity,
		entryModulePath: "<inline:pi-agent-coordination>",
		packageRoot: host.cwd,
		childExtensionFactory: () => () => undefined,
		moderatorExtensionFactory: () => () => undefined,
		activityExtensionFactory: () => () => undefined,
		projectionHost: {
			async createProjection({ session }) {
				const nativeDispose = session.dispose.bind(session);
				session.dispose = () => {
					childSessionDisposals += 1;
					nativeDispose();
				};
				throw new Error("confirmed projection constructor failure");
			},
		},
	});
	const model = host.session.model;
	assert.ok(model);
	let childModelRequests = 0;
	host.model.setResponses([
		() => {
			childModelRequests += 1;
			return fauxAssistantMessage("This response must never start.");
		},
	]);
	const childServices = await createAgentSessionServices({
		cwd: host.cwd,
		agentDir: host.services.agentDir,
		modelRuntime: host.services.modelRuntime,
		settingsManager: host.services.settingsManager,
		resourceLoaderOptions: {
			noContextFiles: true,
			noPromptTemplates: true,
			noSkills: true,
			noThemes: true,
			extensionFactories: [{
				name: "failed-session-start-model-work-probe",
				hidden: true,
				factory(pi) {
					pi.on("session_start", () => {
						pi.sendUserMessage("Do not admit failed child startup work.");
					});
				},
			}],
		},
	});

	await assert.rejects(
		() => factory.startSession({
			sessionManager: SessionManager.inMemory(host.cwd),
			prepared: {
				services: childServices,
				configuration: {
					cwd: host.cwd,
					model: { provider: model.provider, modelId: model.id },
					thinking: "off",
					tools: [],
					skills: [],
					extensions: [],
				},
			},
		}),
		/confirmed projection constructor failure/,
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(childSessionDisposals, 1);
	assert.equal(childModelRequests, 0);
	assert.equal(host.runtime.session, host.session);
	await host.runtime.dispose();
});

async function waitForCondition(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 1_000; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("Timed out waiting for projection state");
}
