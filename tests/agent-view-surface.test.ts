import assert from "node:assert/strict";
import test from "node:test";

import type {
	ExtensionUIContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type {
	Component,
	OverlayHandle,
	TUI,
} from "@earendil-works/pi-tui";

import type { PhysicalTerminalPort } from "../src/presentation/physical-terminal-attachment.ts";
import type { TerminalProjection } from "../src/presentation/terminal-projection.ts";
import {
	openAgentViewSurface,
	startPhysicalAgentViewSurface,
	type DurableAgentView,
} from "../src/presentation/agent-view-surface.ts";

const AGENT_ID = "agent-view-durable-12345678";

test("selected child owns raw output, physical input, and resize until Owner restoration", async () => {
	const projection = createProjectionHarness("first");
	const view = createViewHarness(projection.projection);
	const surface = createSurfaceHarness();

	const opened = openAgentViewSurface(surface.ui, view.view, {
		requestShutdown() {},
		physicalTerminal: surface.physicalTerminal,
	});
	await projection.finishReinitialization();

	assert.deepEqual(surface.ownerStops(), [{ preserveScreen: true }]);
	assert.equal(surface.physicalStarts(), 1);
	assert.deepEqual(projection.attachedStates(), [true]);
	assert.deepEqual(projection.resizes(), [{ columns: 80, rows: 24 }]);

	projection.emitOutput("\x1b[2Jnative child frame");
	assert.deepEqual(surface.physicalWrites(), ["\x1b[2Jnative child frame"]);
	surface.emitInput("mouse-or-editor-input");
	surface.emitResize(100, 30);
	assert.deepEqual(projection.inputs(), ["mouse-or-editor-input"]);
	assert.deepEqual(projection.resizes(), [
		{ columns: 80, rows: 24 },
		{ columns: 100, rows: 30 },
	]);

	await view.closeFromHost();
	await opened;
	assert.deepEqual(projection.attachedStates(), [true, false]);
	assert.equal(surface.physicalStops(), 1);
	assert.equal(surface.ownerStarts(), 1);
	assert.deepEqual(surface.ownerRenderRequests(), [true]);
	assert.equal(view.cleanupCount(), 1);
});

test("a prepared physical surface becomes ready without waiting for its view to close", async () => {
	const projection = createProjectionHarness("prepared");
	const view = createViewHarness(projection.projection);
	const surface = createSurfaceHarness();

	const prepared = startPhysicalAgentViewSurface(view.view, {
		ownerTui: surface.ownerTui,
		physicalTerminal: surface.physicalTerminal,
		requestShutdown() {},
	});
	assert.ok(prepared);
	await projection.finishReinitialization();
	await prepared.ready;
	assert.equal(view.cleanupCount(), 0);
	assert.deepEqual(surface.ownerStops(), [{ preserveScreen: true }]);

	await view.closeFromHost();
	await prepared.closed;
	assert.equal(view.cleanupCount(), 1);
	assert.equal(surface.ownerStarts(), 1);
});

test("an Owner-hosted diagnostic can suspend and resume the exact selected child", async () => {
	const projection = createProjectionHarness("suspend-resume");
	const view = createViewHarness(projection.projection);
	const surface = createSurfaceHarness();
	const prepared = startPhysicalAgentViewSurface(view.view, {
		ownerTui: surface.ownerTui,
		physicalTerminal: surface.physicalTerminal,
		requestShutdown() {},
	});
	assert.ok(prepared);
	await projection.finishReinitialization();
	await prepared.ready;

	await prepared.suspend();
	assert.equal(surface.ownerStarts(), 1);
	assert.deepEqual(projection.attachedStates(), [true, false]);

	await prepared.resume();
	await projection.finishReinitialization();
	assert.deepEqual(surface.ownerStops(), [
		{ preserveScreen: true },
		{ preserveScreen: true },
	]);
	assert.deepEqual(projection.attachedStates(), [true, false, true]);

	prepared.close();
	await prepared.closed;
});

test("handoff buffers child output and physical input until presentation reinitializes", async () => {
	const projection = createProjectionHarness("buffered", undefined, true);
	const view = createViewHarness(projection.projection);
	const surface = createSurfaceHarness();

	const opened = openAgentViewSurface(surface.ui, view.view, {
		requestShutdown() {},
		physicalTerminal: surface.physicalTerminal,
	});
	await projection.waitForReinitialization();
	projection.emitOutput("complete-native-frame");
	surface.emitInput("input-after-handoff");

	assert.deepEqual(
		surface.ownerStops(),
		[],
		"Owner must remain visible until the replacement child frame is complete",
	);
	assert.equal(surface.physicalStarts(), 0);
	assert.deepEqual(surface.physicalWrites(), []);
	assert.deepEqual(projection.inputs(), []);
	await projection.finishReinitialization();

	assert.deepEqual(surface.ownerStops(), [{ preserveScreen: true }]);
	assert.equal(surface.physicalStarts(), 1);
	assert.deepEqual(surface.physicalWrites(), ["complete-native-frame"]);
	assert.deepEqual(projection.inputs(), ["input-after-handoff"]);

	await view.closeFromHost();
	await opened;
});

test("physical output backpressure pauses and resumes the selected child PTY", async () => {
	const projection = createProjectionHarness("backpressured");
	const view = createViewHarness(projection.projection);
	const surface = createSurfaceHarness({ backpressureOn: "blocked-output" });

	const opened = openAgentViewSurface(surface.ui, view.view, {
		requestShutdown() {},
		physicalTerminal: surface.physicalTerminal,
	});
	await projection.finishReinitialization();
	projection.emitOutput("blocked-output");
	projection.emitOutput("queued-output");

	assert.deepEqual(surface.physicalWrites(), ["blocked-output"]);
	assert.equal(projection.outputPauses(), 1);
	assert.equal(projection.outputResumes(), 0);
	await surface.releaseBackpressure();
	assert.deepEqual(surface.physicalWrites(), ["blocked-output", "queued-output"]);
	assert.equal(projection.outputResumes(), 1);

	await view.closeFromHost();
	await opened;
});

test("a diagnostic host keeps xterm active without reinitializing child presentation", async () => {
	const projection = createProjectionHarness("diagnostic", undefined, true);
	const view = createViewHarness(projection.projection);
	const surface = createSurfaceHarness({ supportsPhysicalAttachment: false });

	const opened = openAgentViewSurface(surface.ui, view.view, {
		requestShutdown() {},
		physicalTerminal: surface.physicalTerminal,
	});
	await Promise.resolve();
	surface.emitDiagnosticInput("diagnostic-input");

	assert.deepEqual(projection.attachedStates(), []);
	assert.deepEqual(projection.inputs(), ["diagnostic-input"]);
	assert.deepEqual(surface.ownerStops(), []);
	assert.equal(surface.physicalStarts(), 0);
	await view.closeFromHost();
	await opened;
});

test("retargeting switches one physical lease directly between child PTYs", async () => {
	const first = createProjectionHarness("first");
	const second = createProjectionHarness("second");
	const view = createViewHarness(first.projection);
	const surface = createSurfaceHarness();

	const opened = openAgentViewSurface(surface.ui, view.view, {
		requestShutdown() {},
		physicalTerminal: surface.physicalTerminal,
	});
	await first.finishReinitialization();
	view.replaceProjection(second.projection);
	await second.finishReinitialization();

	assert.deepEqual(first.attachedStates(), [true, false]);
	assert.deepEqual(second.attachedStates(), [true]);
	assert.equal(surface.ownerStops().length, 1);
	assert.equal(surface.ownerStarts(), 0);
	first.emitOutput("stale-first-output");
	second.emitOutput("live-second-output");
	assert.deepEqual(surface.physicalWrites(), ["live-second-output"]);
	surface.emitInput("selected-input");
	assert.deepEqual(first.inputs(), []);
	assert.deepEqual(second.inputs(), ["selected-input"]);

	await view.closeFromHost();
	await opened;
	assert.deepEqual(second.attachedStates(), [true, false]);
	assert.equal(surface.ownerStarts(), 1);
});

test("attachment setup failure restores Owner exactly once and reports the view failure", async () => {
	const setupFailure = new Error("child presentation reinitialization failed");
	const projection = createProjectionHarness("failed", setupFailure);
	const view = createViewHarness(projection.projection);
	const surface = createSurfaceHarness();

	await openAgentViewSurface(surface.ui, view.view, {
		requestShutdown() {},
		physicalTerminal: surface.physicalTerminal,
	});

	assert.deepEqual(view.failures().map(String), [String(setupFailure)]);
	assert.deepEqual(projection.attachedStates(), [true, false]);
	assert.deepEqual(surface.ownerStops(), []);
	assert.equal(surface.physicalStarts(), 0);
	assert.equal(surface.physicalStops(), 0);
	assert.equal(surface.ownerStarts(), 0);
	assert.equal(view.cleanupCount(), 1);
});

test("physical output failure still restores Owner and settles the view", async () => {
	const outputFailure = new Error("physical terminal output failed");
	const projection = createProjectionHarness("output-failure");
	const view = createViewHarness(projection.projection);
	const surface = createSurfaceHarness({ writeFailure: outputFailure });

	const opened = openAgentViewSurface(surface.ui, view.view, {
		requestShutdown() {},
		physicalTerminal: surface.physicalTerminal,
	});
	await projection.finishReinitialization();
	assert.doesNotThrow(() => projection.emitOutput("unwritable-child-output"));
	await opened;

	assert.equal(surface.physicalStops(), 1);
	assert.equal(surface.ownerStarts(), 1);
	assert.deepEqual(surface.ownerRenderRequests(), [true]);
	assert.equal(view.failures().length, 1);
	assert.match(String(view.failures()[0]), /physical terminal output failed/);
});

test("child exit intent restores Owner before delegating shutdown", async () => {
	const projection = createProjectionHarness("exiting");
	const view = createViewHarness(projection.projection);
	const surface = createSurfaceHarness();
	let shutdownRequests = 0;

	const opened = openAgentViewSurface(surface.ui, view.view, {
		requestShutdown: () => shutdownRequests += 1,
		physicalTerminal: surface.physicalTerminal,
	});
	await projection.finishReinitialization();
	projection.emitExitRequest();
	projection.emitExitRequest();
	await opened;

	assert.equal(shutdownRequests, 1);
	assert.equal(surface.ownerStarts(), 1);
	assert.deepEqual(projection.attachedStates(), [true, false]);
});

function createProjectionHarness(
	name: string,
	reinitializationFailure?: Error,
	blockReinitialization = false,
): {
	projection: TerminalProjection;
	waitForReinitialization(): Promise<void>;
	finishReinitialization(): Promise<void>;
	emitOutput(data: string): void;
	emitFailure(error: unknown): void;
	emitExitRequest(): void;
	attachedStates(): readonly boolean[];
	outputPauses(): number;
	outputResumes(): number;
	inputs(): readonly string[];
	resizes(): readonly Readonly<{ columns: number; rows: number }>[];
} {
	const outputHandlers = new Set<(data: string) => void>();
	const failureHandlers = new Set<(error: unknown) => void>();
	const exitHandlers = new Set<() => void>();
	const attachedStates: boolean[] = [];
	let outputPauses = 0;
	let outputResumes = 0;
	const inputs: string[] = [];
	const resizes: Array<{ columns: number; rows: number }> = [];
	let settleReinitialization!: () => void;
	const reinitialized = new Promise<void>((resolve) => {
		settleReinitialization = resolve;
	});
	let releaseReinitialization!: () => void;
	const reinitializationGate = new Promise<void>((resolve) => {
		releaseReinitialization = resolve;
	});
	let settleReinitializationFinished!: () => void;
	const reinitializationFinished = new Promise<void>((resolve) => {
		settleReinitializationFinished = resolve;
	});
	const projection: TerminalProjection = {
		presentation: {
			render: () => [name],
			invalidate() {},
		},
		physicalTerminal: {
			addOutputHandler(handler) {
				outputHandlers.add(handler);
				return () => outputHandlers.delete(handler);
			},
			setAttached(attached) {
				attachedStates.push(attached);
			},
			pauseOutput() {
				outputPauses += 1;
			},
			resumeOutput() {
				outputResumes += 1;
			},
			async reinitializePresentation() {
				settleReinitialization();
				if (blockReinitialization) await reinitializationGate;
				settleReinitializationFinished();
				if (reinitializationFailure) throw reinitializationFailure;
			},
		},
		resize(columns, rows) {
			resizes.push({ columns, rows });
		},
		dispatchInput(data) {
			inputs.push(data);
		},
		focusEditor() {},
		addChangeHandler: () => () => undefined,
		addFailureHandler(handler) {
			failureHandlers.add(handler);
			return () => failureHandlers.delete(handler);
		},
		addExitRequestHandler(handler) {
			exitHandlers.add(handler);
			return () => exitHandlers.delete(handler);
		},
	};
	return {
		projection,
		waitForReinitialization: () => reinitialized,
		async finishReinitialization() {
			releaseReinitialization();
			await reinitializationFinished;
			await Promise.resolve();
		},
		emitOutput(data) {
			for (const handler of outputHandlers) handler(data);
		},
		emitFailure(error) {
			for (const handler of failureHandlers) handler(error);
		},
		emitExitRequest() {
			for (const handler of exitHandlers) handler();
		},
		attachedStates: () => attachedStates,
		outputPauses: () => outputPauses,
		outputResumes: () => outputResumes,
		inputs: () => inputs,
		resizes: () => resizes,
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
		fail(error) {
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

function createSurfaceHarness(options: Readonly<{
	supportsPhysicalAttachment?: boolean;
	backpressureOn?: string;
	writeFailure?: Error;
}> = {}): {
	ui: ExtensionUIContext;
	ownerTui: TUI;
	physicalTerminal: PhysicalTerminalPort;
	emitInput(data: string): void;
	emitDiagnosticInput(data: string): void;
	emitResize(columns: number, rows: number): void;
	releaseBackpressure(): Promise<void>;
	physicalWrites(): readonly string[];
	physicalStarts(): number;
	physicalStops(): number;
	ownerStops(): readonly Readonly<{ preserveScreen?: boolean }>[];
	ownerStarts(): number;
	ownerRenderRequests(): readonly boolean[];
} {
	let activeInput: ((data: string) => void) | undefined;
	let activeResize: ((columns: number, rows: number) => void) | undefined;
	const physicalWrites: string[] = [];
	let settleBackpressure!: () => void;
	const backpressure = new Promise<void>((resolve) => {
		settleBackpressure = resolve;
	});
	let physicalStarts = 0;
	let physicalStops = 0;
	const ownerStops: Array<{ preserveScreen?: boolean }> = [];
	let ownerStarts = 0;
	const ownerRenderRequests: boolean[] = [];
	const physicalTerminal: PhysicalTerminalPort = {
		supportsPhysicalAttachment: options.supportsPhysicalAttachment ?? true,
		columns: () => 80,
		rows: () => 24,
		write(data) {
			if (options.writeFailure) throw options.writeFailure;
			physicalWrites.push(data);
			return data !== options.backpressureOn;
		},
		waitForDrain: () => backpressure,
		start(onInput, onResize) {
			physicalStarts += 1;
			activeInput = onInput;
			activeResize = onResize;
		},
		stop() {
			physicalStops += 1;
			activeInput = undefined;
			activeResize = undefined;
		},
	};
	let customComponent: Component | undefined;
	let focused = true;
	const handle: OverlayHandle = {
		hide() {
			focused = false;
			customComponent = undefined;
		},
		setHidden(value) {
			focused = !value;
		},
		isHidden: () => !focused,
		focus() {
			focused = true;
		},
		unfocus() {
			focused = false;
		},
		isFocused: () => focused,
	};
	const inputListeners = new Set<(
		data: string,
	) => Readonly<{ consume?: boolean; data?: string }> | undefined>();
	const tui = {
		mode: "fullscreen",
		terminal: { columns: 80, rows: 24, write() {} },
		inputListeners,
		addInputListener(listener: (
			data: string,
		) => Readonly<{ consume?: boolean; data?: string }> | undefined) {
			inputListeners.add(listener);
			return () => inputListeners.delete(listener);
		},
		stop(options?: { preserveScreen?: boolean }) {
			ownerStops.push(options ?? {});
		},
		start() {
			ownerStarts += 1;
		},
		requestRender(force = false) {
			ownerRenderRequests.push(force);
		},
	} as unknown as TUI;
	const ui = {
		custom: <T>(
			factory: (
				tui: TUI,
				theme: Theme,
				keybindings: KeybindingsManager,
				done: (result: T) => void,
			) => Component,
			options?: { onHandle?: (handle: OverlayHandle) => void },
		) => new Promise<T>(() => {
			customComponent = factory(
				tui,
				{} as Theme,
				{} as KeybindingsManager,
				() => undefined,
			);
			options?.onHandle?.(handle);
		}),
	} as unknown as ExtensionUIContext;
	return {
		ui,
		ownerTui: tui,
		physicalTerminal,
		emitInput(data) {
			if (activeInput) {
				activeInput(data);
				return;
			}
			let current = data;
			for (const listener of inputListeners) {
				const result = listener(current);
				if (result?.consume) return;
				if (result?.data !== undefined) current = result.data;
			}
		},
		emitDiagnosticInput(data) {
			customComponent?.handleInput?.(data);
		},
		emitResize(columns, rows) {
			activeResize?.(columns, rows);
		},
		async releaseBackpressure() {
			settleBackpressure();
			await new Promise<void>((resolve) => setImmediate(resolve));
		},
		physicalWrites: () => physicalWrites,
		physicalStarts: () => physicalStarts,
		physicalStops: () => physicalStops,
		ownerStops: () => ownerStops,
		ownerStarts: () => ownerStarts,
		ownerRenderRequests: () => ownerRenderRequests,
	};
}
