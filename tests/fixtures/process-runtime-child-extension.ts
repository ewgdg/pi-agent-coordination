import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import type {
	ExtensionFactory,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_AGENT_DIR_ENVIRONMENT_VARIABLE = "PI_CODING_AGENT_DIR";
if (process.env.PI_AGENT_COORDINATION_BOOTSTRAP === undefined) {
	const testAgentDir = mkdtempSync(join(tmpdir(), "pi-process-runtime-agent-"));
	process.env[TEST_AGENT_DIR_ENVIRONMENT_VARIABLE] = testAgentDir;
	process.once("exit", () => rmSync(testAgentDir, { recursive: true, force: true }));
}
export const PROCESS_RUNTIME_TEST_AGENT_DIR =
	process.env[TEST_AGENT_DIR_ENVIRONMENT_VARIABLE]!;

export const PROCESS_RUNTIME_TEST_PROVIDER = "process-runtime-test";
export const PROCESS_RUNTIME_TEST_MODEL = "offline-child";
export const PROCESS_RUNTIME_TEST_ALTERNATE_MODEL = "offline-child-alternate";
export const PROCESS_RUNTIME_TEST_RESPONSE = "PROCESS_RUNTIME_PROMPT_OK";

const faux = createFauxCore({
	api: PROCESS_RUNTIME_TEST_PROVIDER,
	provider: PROCESS_RUNTIME_TEST_PROVIDER,
	models: [
		{
			id: PROCESS_RUNTIME_TEST_MODEL,
			name: "Offline process child",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 16_384,
			maxTokens: 256,
		},
		{
			id: PROCESS_RUNTIME_TEST_ALTERNATE_MODEL,
			name: "Alternate offline process child",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 16_384,
			maxTokens: 256,
		},
	],
});
const delayedResponse = async () => {
	const delayMilliseconds = Number(process.env.PROCESS_RUNTIME_RESPONSE_DELAY_MS ?? 0);
	if (delayMilliseconds > 0) {
		await new Promise((resolve) => setTimeout(resolve, delayMilliseconds));
	}
	return fauxAssistantMessage(PROCESS_RUNTIME_TEST_RESPONSE);
};
faux.setResponses(process.env.PROCESS_RUNTIME_COORDINATION_TOOLS === "1"
	? [
		fauxAssistantMessage([
			fauxToolCall("agent_observe", { operation: "status" }, {
				id: "process-observe-call",
			}),
			fauxToolCall("agent_message", {
				operation: "send",
				targetAgentId: "process-target-agent",
				content: "Exact process message",
			}, { id: "process-message-call" }),
		], { stopReason: "toolUse" }),
		delayedResponse,
	]
	: [
		delayedResponse,
		delayedResponse,
		delayedResponse,
		delayedResponse,
	]);

const processRuntimeChildFixture: ExtensionFactory = (pi) => {
	pi.registerProvider(PROCESS_RUNTIME_TEST_PROVIDER, {
		name: "Offline process runtime test",
		baseUrl: "http://127.0.0.1:1",
		api: PROCESS_RUNTIME_TEST_PROVIDER,
		apiKey: "offline-test",
		models: faux.models,
		streamSimple: faux.streamSimple,
	});

	if (process.env.PROCESS_RUNTIME_HANG_SHUTDOWN === "1") {
		pi.on("session_shutdown", () => new Promise<void>(() => undefined));
	}

	pi.on("input", (event, ctx) => {
		if (event.text === "PROCESS_RUNTIME_HANDLED_INPUT") {
			ctx.ui.setWidget("process-runtime-input", ["PROCESS_RUNTIME_INPUT_HANDLED"]);
			return { action: "handled" };
		}
		if (event.text === "PROCESS_RUNTIME_TRANSFORM_INPUT") {
			return { action: "transform", text: "PROCESS_RUNTIME_TRANSFORMED_INPUT" };
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		// Test-only fault injection: the bridge receives the public readonly view,
		// while Pi owns the writable SessionManager behind that same object.
		const sessionManager = ctx.sessionManager as unknown as SessionManager;
		const appendMessage = sessionManager.appendMessage.bind(sessionManager);
		sessionManager.appendMessage = (message) => {
			if (
				message.role === "user" &&
				JSON.stringify(message.content).includes("PROCESS_RUNTIME_DROP_MESSAGE_COMMIT")
			) return "suppressed-process-runtime-test-entry";
			return appendMessage(message);
		};
		ctx.ui.setWidget("process-runtime-test", [
			"PROCESS_RUNTIME_CHILD_WIDGET",
			`PID=${process.pid}`,
			`HERDR_ENV=${String(process.env.HERDR_ENV)}`,
			`HERDR_SOCKET_PATH=${String(process.env.HERDR_SOCKET_PATH)}`,
			`HERDR_PANE_ID=${String(process.env.HERDR_PANE_ID)}`,
			`AGENT_DIR=${String(process.env.PI_CODING_AGENT_DIR)}`,
		]);
		const delayMilliseconds = Number(process.env.PROCESS_RUNTIME_STARTUP_DELAY_MS ?? 0);
		if (delayMilliseconds > 0) {
			await new Promise((resolve) => setTimeout(resolve, delayMilliseconds));
		}
	});

	pi.registerTool({
		name: "runtime_sequential_probe",
		label: "Runtime sequential probe",
		description: "Tests current process Runtime tool classification.",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		executionMode: "sequential",
		async execute() {
			return {
				content: [{ type: "text", text: "runtime sequential probe" }],
				details: {},
			};
		},
	});
	pi.registerCommand("runtime-state", {
		description: "Change effective process Runtime state",
		async handler(_args, ctx) {
			await pi.setModel(faux.models[1]!);
			pi.setActiveTools([]);
			ctx.ui.setWidget("process-runtime-state", ["PROCESS_RUNTIME_STATE_CHANGED"]);
		},
	});

	pi.registerCommand("runtime-probe", {
		description: "Show process runtime PTY input and dimensions",
		async handler(args, ctx) {
			const [rows, columns] = execFileSync("stty", ["size"], {
				encoding: "utf8",
				stdio: ["inherit", "pipe", "ignore"],
			}).trim().split(/\s+/);
			ctx.ui.setWidget("process-runtime-test", [
				"PROCESS_RUNTIME_CHILD_WIDGET",
				`INPUT=${args}`,
				`SIZE=${columns}x${rows}`,
				`HERDR_ENV=${String(process.env.HERDR_ENV)}`,
				`HERDR_SOCKET_PATH=${String(process.env.HERDR_SOCKET_PATH)}`,
				`HERDR_PANE_ID=${String(process.env.HERDR_PANE_ID)}`,
			]);
		},
	});
};

export default processRuntimeChildFixture;
