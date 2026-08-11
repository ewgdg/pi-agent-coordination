import {
	createFauxCore,
	fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import type {
	ExtensionFactory,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";

export const PROCESS_RUNTIME_TEST_PROVIDER = "process-runtime-test";
export const PROCESS_RUNTIME_TEST_MODEL = "offline-child";
export const PROCESS_RUNTIME_TEST_RESPONSE = "PROCESS_RUNTIME_PROMPT_OK";

const faux = createFauxCore({
	api: PROCESS_RUNTIME_TEST_PROVIDER,
	provider: PROCESS_RUNTIME_TEST_PROVIDER,
	models: [{
		id: PROCESS_RUNTIME_TEST_MODEL,
		name: "Offline process child",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 16_384,
		maxTokens: 256,
	}],
});
const delayedResponse = async () => {
	const delayMilliseconds = Number(process.env.PROCESS_RUNTIME_RESPONSE_DELAY_MS ?? 0);
	if (delayMilliseconds > 0) {
		await new Promise((resolve) => setTimeout(resolve, delayMilliseconds));
	}
	return fauxAssistantMessage(PROCESS_RUNTIME_TEST_RESPONSE);
};
faux.setResponses([
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

	pi.on("input", (event) => {
		if (event.text === "PROCESS_RUNTIME_HANDLED_INPUT") return { action: "handled" };
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
		]);
		const delayMilliseconds = Number(process.env.PROCESS_RUNTIME_STARTUP_DELAY_MS ?? 0);
		if (delayMilliseconds > 0) {
			await new Promise((resolve) => setTimeout(resolve, delayMilliseconds));
		}
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
