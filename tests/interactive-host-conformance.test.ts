import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";

import xtermHeadless from "@xterm/headless";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
	TUI,
	type Component,
	type Terminal,
} from "@earendil-works/pi-tui";
import * as hostPi from "@earendil-works/pi-coding-agent";

import piAgentCoordination from "../src/index.ts";
import { installInteractiveHostBridge } from "../src/pi-integration/interactive-host-bridge.ts";
import {
	resetSessionStartProbe,
	sessionStartReasons,
} from "./fixtures/session-start-probe-extension.ts";
import {
	executeAndCommitRegisteredTool,
	selectAgent,
} from "./support/agent-session.ts";
import {
	createPiCliTestOwnerHost,
	createTestOwnerHost,
	createUnboundTestOwnerHost,
} from "./support/pi-host.ts";

const SESSION_START_PROBE = fileURLToPath(
	new URL("./fixtures/session-start-probe-extension.ts", import.meta.url),
);
const { Terminal: XtermTerminal } = xtermHeadless;
const TERMINAL_COLUMNS = 80;
const TERMINAL_ROWS = 12;
const LLAMA_MODEL_ID = "local-conformance-model";

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

test("the named llama.cpp extension remains usable through child startup and shutdown on the shared ModelRuntime", async () => {
	const router = await startMockLlamaRouter();
	const previousBaseUrl = process.env.LLAMA_BASE_URL;
	const previousApiKey = process.env.LLAMA_API_KEY;
	process.env.LLAMA_BASE_URL = router.baseUrl;
	process.env.LLAMA_API_KEY = "local-conformance-key";
	hostPi.initTheme();
	const host = await createPiCliTestOwnerHost(piAgentCoordination, { persistent: true });
	try {
		const sharedModelRuntime = host.services.modelRuntime;
		assert.ok(sharedModelRuntime.getProvider("llama.cpp"));
		await refreshLlamaCatalogThroughCommand(host, host.session);
		await assertLlamaInference(sharedModelRuntime, "before child startup");
		host.model.setResponses([
			fauxAssistantMessage("Remain live while llama.cpp conformance is checked."),
		]);
		const childAgentId = await spawnRetainedChild(host);
		assert.ok(sharedModelRuntime.getModel("llama.cpp", LLAMA_MODEL_ID));
		await assertLlamaInference(sharedModelRuntime, "after child startup");

		await selectAgent(host, childAgentId);
		const child = host.runtime.session;
		assert.equal(host.runtime.services.modelRuntime, sharedModelRuntime);
		await refreshLlamaCatalogThroughCommand(host, child);
		await assertLlamaInference(sharedModelRuntime, "from the child Run");

		await selectAgent(host, host.session.sessionId);
		await assertLlamaInference(sharedModelRuntime, "from the Owner while the child is live");
		await executeAndCommitRegisteredTool(
			host.session,
			"agent_control",
			"terminate-llama-child",
			{
				operation: "terminate",
				agentId: childAgentId,
			},
		);
		assert.ok(sharedModelRuntime.getProvider("llama.cpp"));
		await assertLlamaInference(sharedModelRuntime, "after child shutdown");
	} finally {
		if (previousBaseUrl === undefined) delete process.env.LLAMA_BASE_URL;
		else process.env.LLAMA_BASE_URL = previousBaseUrl;
		if (previousApiKey === undefined) delete process.env.LLAMA_API_KEY;
		else process.env.LLAMA_API_KEY = previousApiKey;
		await host.runtime.dispose();
		await router.close();
	}
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
	const result = await executeAndCommitRegisteredTool(
		host.session,
		"agent_spawn",
		toolCallId,
		input,
	);
	assert.equal((result.details as { disposition: string }).disposition, "pending");
	return (result.details as { agentId: string }).agentId;
}

async function refreshLlamaCatalogThroughCommand(
	host: Awaited<ReturnType<typeof createTestOwnerHost>>,
	session: hostPi.AgentSession,
): Promise<void> {
	const prompt = session.prompt("/llama");
	await waitForCondition(() => host.ui.customSurfaces.length === 1);
	const surface = host.ui.customSurfaces[0];
	assert.ok(surface?.handleInput);
	try {
		await waitForCondition(() =>
			surface.render(120).some((line) => line.includes(LLAMA_MODEL_ID))
		);
	} catch {
		throw new Error(
			`llama.cpp catalog did not render:\n${surface.render(120).join("\n")}\n` +
			`notifications: ${JSON.stringify(host.ui.notifications)}`,
		);
	}
	surface.handleInput("\x1b");
	await prompt;
}

async function assertLlamaInference(
	modelRuntime: hostPi.ModelRuntime,
	prompt: string,
): Promise<void> {
	const model = modelRuntime.getModel("llama.cpp", LLAMA_MODEL_ID);
	assert.ok(model);
	const response = await modelRuntime.completeSimple(model, {
		messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
	});
	assert.equal(response.stopReason, "stop");
	assert.deepEqual(response.content, [{ type: "text", text: "llama conformance response" }]);
}

async function startMockLlamaRouter(): Promise<{
	baseUrl: string;
	close(): Promise<void>;
}> {
	let completionSequence = 0;
	const server = createServer((request, response) => {
		request.resume();
		if (request.url === "/models") {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({
				data: [{
					id: LLAMA_MODEL_ID,
					status: { value: "loaded" },
					meta: { n_ctx: 8_192 },
					architecture: { input_modalities: ["text"] },
				}],
			}));
			return;
		}
		if (request.url === "/v1/chat/completions") {
			completionSequence += 1;
			response.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			response.write(`data: ${JSON.stringify({
				id: `llama-conformance-${completionSequence}`,
				model: LLAMA_MODEL_ID,
				choices: [{
					index: 0,
					delta: { role: "assistant", content: "llama conformance response" },
					finish_reason: null,
				}],
			})}\n\n`);
			response.write(`data: ${JSON.stringify({
				id: `llama-conformance-${completionSequence}`,
				model: LLAMA_MODEL_ID,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			})}\n\n`);
			response.end("data: [DONE]\n\n");
			return;
		}
		response.writeHead(404).end();
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		close: () => new Promise<void>((resolve, reject) => {
			server.close((error) => error ? reject(error) : resolve());
		}),
	};
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 1_000; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("Expected conformance condition did not become true");
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
