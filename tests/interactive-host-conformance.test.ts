import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import xtermHeadless from "@xterm/headless";
import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import {
	TUI,
	type Component,
	type Terminal,
} from "@earendil-works/pi-tui";
import * as hostPi from "@earendil-works/pi-coding-agent";

import piAgentCoordination from "../src/index.ts";
import {
	resetSessionStartProbe,
	sessionStartReasons,
} from "./fixtures/session-start-probe-extension.ts";
import { createTestOwnerHost } from "./support/pi-host.ts";
import { installInteractiveHostBridge } from "../src/pi-integration/interactive-host-bridge.ts";
import { createUnboundTestOwnerHost } from "./support/pi-host.ts";

const SESSION_START_PROBE = fileURLToPath(
	new URL("./fixtures/session-start-probe-extension.ts", import.meta.url),
);
const { Terminal: XtermTerminal } = xtermHeadless;
const TERMINAL_COLUMNS = 80;
const TERMINAL_ROWS = 12;

test("retained native selection refreshes bindings without replaying session startup", async () => {
	resetSessionStartProbe();
	const host = await createTestOwnerHost(piAgentCoordination, {
		persistent: true,
		additionalExtensionPaths: [SESSION_START_PROBE],
	});
	host.model.setResponses([
		fauxAssistantMessage("Remain live while native selection moves between Agents."),
	]);
	const childAgentId = await spawnRetainedChild(host);

	host.ui.select = async (_title, options) =>
		options.find((option) => option.includes(childAgentId));
	await host.session.prompt("/agents");
	const selectedChild = host.runtime.session;
	const observe = selectedChild.getToolDefinition("agent_observe");
	assert.ok(observe);
	const childStatus = await observe.execute(
		"observe-selected-child-closure",
		{ operation: "status" },
		undefined,
		undefined,
		selectedChild.extensionRunner.createContext(),
	);
	assert.equal((childStatus.details as { agentId: string }).agentId, childAgentId);
	const childCoordinationExtensions = host.runtime.services.resourceLoader
		.getExtensions()
		.extensions.filter((extension) => extension.tools.has("agent_spawn"));
	assert.equal(childCoordinationExtensions.length, 1);
	assert.equal(childCoordinationExtensions[0]?.hidden, true);
	assert.equal(
		childCoordinationExtensions[0]?.handlers.has("session_start"),
		false,
	);
	host.ui.select = async (_title, options) =>
		options.find((option) => option.includes(host.session.sessionId));
	await selectedChild.prompt("/agents");
	host.ui.select = async (_title, options) =>
		options.find((option) => option.includes(childAgentId));
	await host.runtime.session.prompt("/agents");

	assert.deepEqual(sessionStartReasons(host.session.sessionId), ["startup"]);
	assert.deepEqual(sessionStartReasons(childAgentId), ["startup"]);
	await host.runtime.dispose();
});

test("native long-to-short rebinding reconstructs the complete terminal viewport", async () => {
	installInteractiveHostBridge(hostPi);
	const researcherHost = await createUnboundTestOwnerHost(() => undefined);
	const ownerHost = await createUnboundTestOwnerHost(() => undefined);
	researcherHost.runtime.setBeforeSessionInvalidate(() => undefined);
	researcherHost.runtime.setRebindSession(async () => undefined);
	const terminal = new HeadlessTerminal();
	const tui = new TUI(terminal);
	const visibleTranscript = new MutableTranscript(transcript("Researcher", 20));
	tui.addChild(visibleTranscript);
	tui.requestRender(true);
	await terminal.settle();
	const researcherSession = researcherHost.session;
	const ownerSession = ownerHost.session;
	const runtimeHost = researcherHost.runtime;
	const mode = Object.assign(Object.create(hostPi.InteractiveMode.prototype), {
		runtimeHost,
		ui: tui,
		applyRuntimeSettings() {},
		renderCurrentSessionState() {
			visibleTranscript.lines = runtimeHost.session === ownerSession
				? transcript("Owner", 14)
				: transcript("Researcher", 20);
			tui.requestRender();
		},
		createExtensionUIContext: () => researcherHost.ui,
		setupAutocompleteProvider() {},
		setupExtensionShortcuts() {},
		showLoadedResources() {},
		showStartupNoticesIfNeeded() {},
		showExtensionError() {},
		subscribeToAgent() {},
		async updateAvailableProviderCount() {},
		updateEditorBorderColor() {},
		updateTerminalTitle() {},
		clearStatusIndicator() {},
		setWorkingVisible() {},
	}) as InstanceType<typeof hostPi.InteractiveMode>;
	const rebindCurrentSession = (
		mode as unknown as {
			rebindCurrentSession(options: { renderBeforeBind: boolean }): Promise<void>;
		}
	).rebindCurrentSession.bind(mode);

	await rebindCurrentSession({ renderBeforeBind: true });
	const mutableRuntime = runtimeHost as unknown as {
		_session: typeof ownerSession;
		_services: typeof ownerHost.services;
	};
	mutableRuntime._session = ownerSession;
	mutableRuntime._services = ownerHost.services;
	await rebindCurrentSession({ renderBeforeBind: true });
	await terminal.settle();

	assert.equal(terminal.bottomViewportLine(), "Owner FOOTER");
	assert.equal(terminal.viewport().some((line) => line.includes("Researcher")), false);
	await researcherHost.runtime.dispose();
	researcherSession.dispose();
});

async function spawnRetainedChild(
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
): Promise<string> {
	const input = { request: "Remain live for native selection conformance." };
	const toolCallId = "spawn-native-selection-conformance-child";
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_spawn", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const spawn = host.session.getToolDefinition("agent_spawn");
	assert.ok(spawn);
	const result = await spawn.execute(
		toolCallId,
		input,
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	return (result.details as { agentId: string }).agentId;
}

class MutableTranscript implements Component {
	lines: string[];
	constructor(lines: string[]) {
		this.lines = lines;
	}
	invalidate(): void {}
	render(): string[] {
		return this.lines;
	}
}

class HeadlessTerminal implements Terminal {
	readonly #xterm = new XtermTerminal({
		allowProposedApi: true,
		cols: TERMINAL_COLUMNS,
		rows: TERMINAL_ROWS,
		scrollback: 100,
	});
	#pendingWrites = Promise.resolve();

	get columns(): number {
		return TERMINAL_COLUMNS;
	}
	get rows(): number {
		return TERMINAL_ROWS;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	moveBy(): void {}
	write(data: string): void {
		this.#pendingWrites = this.#pendingWrites.then(
			() => new Promise<void>((resolve) => this.#xterm.write(data, resolve)),
		);
	}
	async settle(): Promise<void> {
		await new Promise<void>((resolve) => setImmediate(resolve));
		await new Promise<void>((resolve) => setImmediate(resolve));
		await this.#pendingWrites;
	}
	bottomViewportLine(): string {
		return this.viewport().at(-1) ?? "";
	}
	viewport(): string[] {
		this.#xterm.scrollToBottom();
		const buffer = this.#xterm.buffer.active;
		return Array.from({ length: TERMINAL_ROWS }, (_value, index) =>
			buffer
				.getLine(buffer.viewportY + index)
				?.translateToString(true)
				.trim() ?? "",
		);
	}
}

function transcript(agent: string, lineCount: number): string[] {
	const sharedHeader = Array.from(
		{ length: 10 },
		(_value, index) => `Shared Pi layout ${index + 1}`,
	);
	return [
		...sharedHeader,
		...Array.from(
			{ length: lineCount - sharedHeader.length - 1 },
			(_value, index) => `${agent} transcript ${index + 1}`,
		),
		`${agent} FOOTER`,
	];
}
