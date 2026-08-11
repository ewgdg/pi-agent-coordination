import assert from "node:assert/strict";
import test from "node:test";

import type {
	ExtensionUIContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	stripTerminalSequences,
	visibleWidth,
	type Component,
	type OverlayHandle,
	type TUI,
} from "@earendil-works/pi-tui";

import type { TerminalProjection } from "../src/presentation/terminal-projection.ts";
import {
	openAgentViewSurface,
	type DurableAgentView,
} from "../src/presentation/agent-view-surface.ts";

const AGENT_ID = "agent-view-durable-12345678";

test("the full-window Agent view renders the complete child frame and forwards native input", async () => {
	const projection = projectionWithFrame("live", [
		"native transcript",
		"native working state",
		"native Agent editor",
		"native Agent footer",
	]);
	const view = createViewHarness(projection);
	const ui = createSurfaceHarness(8);

	const opened = openAgentViewSurface(ui.ui, view.view);
	await ui.ready;
	assert.deepEqual(ui.terminalWrites(), [
		"\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h",
	]);

	const { onHandle, ...surfaceOptions } = ui.options as {
		onHandle?: unknown;
		overlay: boolean;
		overlayOptions: unknown;
	};
	assert.equal(typeof onHandle, "function");
	assert.deepEqual(surfaceOptions, {
		overlay: true,
		overlayOptions: {
			anchor: "top-left",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
		},
	});
	const rendered = renderText(ui.component, 40);
	assert.equal(rendered.length, 8);
	assert.ok(rendered.every((line) => visibleWidth(line) <= 40));
	assert.doesNotMatch(rendered.join("\n"), /Durable Agent|12345678|Live/);
	assert.deepEqual(ui.backgroundWidths(), []);
	assert.notEqual(rendered[0], "─".repeat(40));
	assert.match(rendered.join("\n"), /native transcript/);
	assert.match(rendered.join("\n"), /native Agent editor/);
	assert.match(rendered.join("\n"), /native Agent footer/);

	for (const input of ["x", "\r", "\x1b"]) ui.component.handleInput?.(input);
	assert.deepEqual(projection.inputs(), ["x", "\r", "\x1b"]);
	ui.component.handleInput?.("\x1b[<0;10;1M");
	ui.component.handleInput?.("\x1b[<0;10;5M");
	ui.component.handleInput?.("\x1b[M !!");
	ui.component.handleInput?.("\x1b[M !%");
	assert.deepEqual(projection.inputs(), [
		"x",
		"\r",
		"\x1b",
		"\x1b[<0;10;1M",
		"\x1b[<0;10;5M",
		"\x1b[M !!",
		"\x1b[M !%",
	]);
	assert.equal(view.cleanupCount(), 0);
	assert.equal(ui.doneCalls(), 0);

	await view.closeFromHost();
	await opened;
	assert.deepEqual(ui.terminalWrites(), [
		"\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h",
		"\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l",
	]);
	assert.equal(view.cleanupCount(), 1);
	assert.equal(ui.doneCalls(), 0);
	assert.equal(ui.handle.isFocused(), false);
});

test("terminal resize keeps the complete child frame bounded to the full window", async () => {
	const projection = projectionWithFrame("live", [
		"a native child line that is intentionally wider than every narrow terminal",
		"native editor",
		"native footer",
	]);
	const view = createViewHarness(projection);
	const ui = createSurfaceHarness(8);
	const opened = openAgentViewSurface(ui.ui, view.view);
	await ui.ready;

	for (const { rows, width } of [
		{ rows: 1, width: 12 },
		{ rows: 3, width: 24 },
		{ rows: 12, width: 60 },
		{ rows: 5, width: 18 },
	]) {
		ui.setRows(rows);
		const rendered = ui.component.render(width);
		assert.equal(rendered.length, rows);
		assert.ok(rendered.every((line) => visibleWidth(line) <= width));
	}

	await view.closeFromHost();
	await opened;
});

test("a fullscreen Owner routes mouse input to the Agent before its own viewport", async () => {
	const projection = projectionWithFrame("dormant", [
		"persisted transcript",
		"Dormant editor",
		"Dormant footer",
	]);
	const view = createViewHarness(projection);
	const ui = createSurfaceHarness(8, "fullscreen");
	const opened = openAgentViewSurface(ui.ui, view.view);
	await ui.ready;

	ui.dispatchTerminalInput("\x1b[<64;10;5M");
	ui.dispatchTerminalInput("\x1b[<0;80;5M");
	ui.dispatchTerminalInput("\x1b[<32;80;7M");
	ui.dispatchTerminalInput("\x1b[<0;80;7m");
	ui.dispatchTerminalInput("x");
	assert.deepEqual(projection.inputs(), [
		"\x1b[<64;10;5M",
		"\x1b[<0;80;5M",
		"\x1b[<32;80;7M",
		"\x1b[<0;80;7m",
		"x",
	]);
	assert.equal(ui.ownerViewportMouseEvents(), 0);

	await view.closeFromHost();
	await opened;
	ui.dispatchTerminalInput("\x1b[<64;10;5M");
	assert.equal(ui.ownerViewportMouseEvents(), 1);
});

test("a focused Owner overlay receives input above the selected Agent view", async () => {
	const projection = projectionWithFrame("live", ["child frame"]);
	const view = createViewHarness(projection);
	const ui = createSurfaceHarness(8);
	const opened = openAgentViewSurface(ui.ui, view.view);
	await ui.ready;
	const ownerOverlayInputs: string[] = [];
	const ownerOverlay: Component = {
		render: () => ["Owner overlay"],
		handleInput: (data) => ownerOverlayInputs.push(data),
		invalidate() {},
	};

	ui.handle.unfocus({ target: ownerOverlay });
	ui.dispatchTerminalInput("Human Answer");
	ui.dispatchTerminalInput("\r");
	assert.deepEqual(ownerOverlayInputs, ["Human Answer", "\r"]);
	assert.deepEqual(projection.inputs(), []);

	ui.handle.focus();
	ui.dispatchTerminalInput("child input");
	assert.deepEqual(projection.inputs(), ["child input"]);

	await view.closeFromHost();
	await opened;
});

test("a child render failure closes the exact view and returns a bounded frame", async () => {
	const projection = projectionWithFrame("live", ["unreachable child frame"]);
	projection.presentation.render = () => {
		throw new Error("deterministic child render failure");
	};
	const view = createViewHarness(projection);
	const ui = createSurfaceHarness(8);
	const opened = openAgentViewSurface(ui.ui, view.view);
	await ui.ready;

	let failedFrame: string[] = [];
	assert.doesNotThrow(() => {
		failedFrame = ui.component.render(40);
	});
	assert.equal(failedFrame.length, 8);
	assert.match(failedFrame.join("\n"), /Agent view failed; returning to Owner/);
	await opened;
	assert.deepEqual(view.failures().map(String), [
		"Error: deterministic child render failure",
	]);
	assert.equal(view.cleanupCount(), 1);
	assert.equal(ui.handle.isFocused(), false);
	assert.deepEqual(ui.terminalWrites(), [
		"\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h",
		"\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l",
	]);
});

test("a child input failure is consumed once and restores fullscreen Owner routing", async () => {
	const projection = projectionWithFrame(
		"live",
		["child frame"],
		{ dispatchInputError: new Error("deterministic child input failure") },
	);
	const view = createViewHarness(projection);
	const ui = createSurfaceHarness(8, "fullscreen");
	const opened = openAgentViewSurface(ui.ui, view.view);
	await ui.ready;

	assert.doesNotThrow(() => ui.dispatchTerminalInput("x"));
	await opened;
	assert.deepEqual(view.failures().map(String), [
		"Error: deterministic child input failure",
	]);
	ui.dispatchTerminalInput("\x1b[<64;10;5M");
	assert.equal(ui.ownerViewportMouseEvents(), 1);
});

test("an asynchronous child input-loop failure closes the view once", async () => {
	const projection = projectionWithFrame("live", ["child frame"]);
	const view = createViewHarness(projection);
	const ui = createSurfaceHarness(8, "fullscreen");
	const opened = openAgentViewSurface(ui.ui, view.view);
	await ui.ready;

	projection.emitFailure(new Error("deterministic input acquisition failure"));
	projection.emitFailure(new Error("duplicate failure must be ignored"));
	await opened;
	assert.deepEqual(view.failures().map(String), [
		"Error: deterministic input acquisition failure",
	]);
	assert.equal(view.cleanupCount(), 1);
});

test("child quit intent delegates once to the Owner process owner", async () => {
	const projection = projectionWithFrame("live", ["child frame"]);
	const view = createViewHarness(projection);
	const ui = createSurfaceHarness(8);
	let shutdownRequests = 0;
	const opened = openAgentViewSurface(ui.ui, view.view, {
		requestShutdown: () => {
			shutdownRequests += 1;
		},
	});
	await ui.ready;

	projection.emitExitRequest();
	projection.emitExitRequest();
	assert.equal(shutdownRequests, 1);
	await view.closeFromHost();
	await opened;
});

test("projection retargeting keeps one interactive surface and host close settles once", async () => {
	const live = projectionWithFrame("live", ["live frame", "live editor", "live footer"]);
	const dormant = projectionWithFrame("dormant", [
		"persisted dormant frame",
		"Dormant editor",
		"Dormant footer",
	]);
	const view = createViewHarness(live);
	const ui = createSurfaceHarness(8);

	const opened = openAgentViewSurface(ui.ui, view.view);
	await ui.ready;
	const component = ui.component;
	assert.doesNotMatch(renderText(component, 50).join("\n"), /Durable Agent|12345678|Live/);
	assert.deepEqual(live.handlerCounts(), { changes: 0, failures: 1, exits: 1 });

	view.replaceProjection(dormant);
	assert.equal(ui.renderRequests(), 1);
	assert.equal(ui.component, component);
	assert.match(
		renderText(component, 50).join("\n"),
		/persisted dormant frame[\s\S]*Dormant editor/,
	);
	assert.doesNotMatch(renderText(component, 50).join("\n"), /Durable Agent|12345678/);
	assert.deepEqual(live.handlerCounts(), { changes: 0, failures: 0, exits: 0 });
	assert.deepEqual(dormant.handlerCounts(), { changes: 0, failures: 1, exits: 1 });

	await view.closeFromHost();
	await opened;
	assert.equal(view.cleanupCount(), 1);
	assert.equal(ui.doneCalls(), 0);
	assert.equal(ui.handle.isFocused(), false);
	assert.deepEqual(dormant.handlerCounts(), { changes: 0, failures: 0, exits: 0 });
});

function projectionWithFrame(
	_name: string,
	initialFrame: readonly string[],
	options?: { dispatchInputError?: Error },
): TerminalProjection & {
	setFrame(lines: readonly string[]): void;
	inputs(): readonly string[];
	emitFailure(error: unknown): void;
	emitExitRequest(): void;
	handlerCounts(): Readonly<{ changes: number; failures: number; exits: number }>;
} {
	let frame = [...initialFrame];
	const inputs: string[] = [];
	const handlers = new Set<() => void>();
	const failureHandlers = new Set<(error: unknown) => void>();
	const exitRequestHandlers = new Set<() => void>();
	return {
		presentation: {
			render: () => frame,
			invalidate() {},
		},
		resize() {},
		dispatchInput(data) {
			if (options?.dispatchInputError) throw options.dispatchInputError;
			inputs.push(data);
		},
		focusEditor() {},
		addChangeHandler(handler) {
			handlers.add(handler);
			return () => handlers.delete(handler);
		},
		addFailureHandler(handler) {
			failureHandlers.add(handler);
			return () => failureHandlers.delete(handler);
		},
		addExitRequestHandler(handler) {
			exitRequestHandlers.add(handler);
			return () => exitRequestHandlers.delete(handler);
		},
		setFrame(lines) {
			frame = [...lines];
			for (const handler of handlers) handler();
		},
		inputs: () => inputs,
		emitFailure(error) {
			for (const handler of failureHandlers) handler(error);
		},
		emitExitRequest() {
			for (const handler of exitRequestHandlers) handler();
		},
		handlerCounts: () => ({
			changes: handlers.size,
			failures: failureHandlers.size,
			exits: exitRequestHandlers.size,
		}),
	};
}

function createViewHarness(initialProjection: TerminalProjection): {
	view: DurableAgentView;
	replaceProjection(projection: TerminalProjection): void;
	closeFromHost(): Promise<void>;
	cleanupCount(): number;
	failures(): readonly unknown[];
} {
	let projection = initialProjection;
	let closed = false;
	let cleanups = 0;
	const failures: unknown[] = [];
	const changeHandlers = new Set<() => void>();
	const closeHandlers = new Set<() => void>();
	const view: DurableAgentView = {
		agentId: AGENT_ID,
		label: "Durable Agent",
		projection: () => projection,
		addChangeHandler(handler) {
			changeHandlers.add(handler);
			return () => changeHandlers.delete(handler);
		},
		addCloseHandler(handler) {
			closeHandlers.add(handler);
			return () => closeHandlers.delete(handler);
		},
		async close() {
			if (closed) return;
			closed = true;
			cleanups += 1;
			for (const handler of closeHandlers) handler();
		},
		fail(error: unknown) {
			failures.push(error);
			void view.close();
		},
	};
	return {
		view,
		replaceProjection(next) {
			projection = next;
			for (const handler of changeHandlers) handler();
		},
		closeFromHost: () => view.close(),
		cleanupCount: () => cleanups,
		failures: () => failures,
	};
}

function createSurfaceHarness(
	rows: number,
	mode: "regular" | "fullscreen" = "regular",
): {
	ui: ExtensionUIContext;
	ready: Promise<void>;
	component: Component;
	options: unknown;
	handle: OverlayHandle;
	setRows(rows: number): void;
	doneCalls(): number;
	renderRequests(): number;
	terminalWrites(): readonly string[];
	dispatchTerminalInput(data: string): void;
	ownerViewportMouseEvents(): number;
	backgroundWidths(): readonly number[];
} {
	let component: Component | undefined;
	let focusedComponent: Component | undefined;
	let options: unknown;
	let renderRequests = 0;
	let doneCalls = 0;
	const terminalWrites: string[] = [];
	let ownerViewportMouseEvents = 0;
	const backgroundWidths: number[] = [];
	const inputListeners = new Set<(
		data: string,
	) => { consume?: boolean; data?: string } | undefined>();
	if (mode === "fullscreen") {
		inputListeners.add((data) => {
			if (!/^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data)) return undefined;
			ownerViewportMouseEvents += 1;
			return { consume: true };
		});
	}
	let markReady!: () => void;
	const ready = new Promise<void>((resolve) => {
		markReady = resolve;
	});
	let hidden = false;
	let focused = true;
	const handle: OverlayHandle = {
		hide() {
			hidden = true;
			focused = false;
			if (focusedComponent === component) focusedComponent = undefined;
		},
		setHidden(value) {
			hidden = value;
		},
		isHidden: () => hidden,
		focus() {
			focused = true;
			hidden = false;
			focusedComponent = component;
		},
		unfocus(unfocusOptions) {
			focused = false;
			focusedComponent = unfocusOptions?.target ?? undefined;
		},
		isFocused: () => focused,
	};
	const terminal = {
		columns: 80,
		rows,
		write(data: string) {
			terminalWrites.push(data);
		},
	};
	const tui = {
		mode,
		terminal,
		inputListeners,
		addInputListener(listener: (data: string) => { consume?: boolean; data?: string } | undefined) {
			inputListeners.add(listener);
			return () => inputListeners.delete(listener);
		},
		requestRender() {
			renderRequests += 1;
		},
	} as unknown as TUI;
	const theme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => {
			backgroundWidths.push(visibleWidth(text));
			return text;
		},
		bold: (text: string) => text,
	} as unknown as Theme;
	const ui = {
		custom: <T>(
			factory: (
				tui: TUI,
				theme: Theme,
				keybindings: KeybindingsManager,
				done: (result: T) => void,
			) => Component,
			customOptions?: unknown,
		) => new Promise<T>((resolve) => {
			options = customOptions;
			const done = (result: T) => {
				doneCalls += 1;
				handle.hide();
				(component as (Component & { dispose?(): void }) | undefined)?.dispose?.();
				resolve(result);
			};
			component = factory(tui, theme, {} as KeybindingsManager, done);
			focusedComponent = component;
			(customOptions as { onHandle?: (handle: OverlayHandle) => void } | undefined)
				?.onHandle?.(handle);
			markReady();
		}),
	} as unknown as ExtensionUIContext;
	return {
		ui,
		ready,
		get component() {
			assert.ok(component);
			return component;
		},
		get options() {
			return options;
		},
		handle,
		setRows(nextRows) {
			terminal.rows = nextRows;
		},
		doneCalls: () => doneCalls,
		renderRequests: () => renderRequests,
		terminalWrites: () => terminalWrites,
		dispatchTerminalInput(data) {
			let current = data;
			for (const listener of inputListeners) {
				const result = listener(current);
				if (result?.consume) return;
				if (result?.data !== undefined) current = result.data;
			}
			focusedComponent?.handleInput?.(current);
		},
		ownerViewportMouseEvents: () => ownerViewportMouseEvents,
		backgroundWidths: () => backgroundWidths,
	};
}

function renderText(component: Component, width: number): string[] {
	return component.render(width).map((line) => stripTerminalSequences(line));
}
