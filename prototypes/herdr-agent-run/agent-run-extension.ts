import { timingSafeEqual, randomUUID } from "node:crypto";
import { chmod, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const BLOCKED_EVENT = "herdr:blocked";
const CONTROL_SOCKET_FLAG = "prototype-control-socket";
const CONTROL_TOKEN_FLAG = "prototype-control-token";
const MAX_REQUEST_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 2_000;
const PROTOCOL_VERSION = 1;

type Operation = "probe" | "submit" | "steer" | "abort" | "request_human" | "shutdown";

type ControlRequest = {
	version: number;
	id: string;
	token: string;
	op: Operation;
	text?: string;
};

type ControlResponse = {
	version: number;
	id: string;
	ok: boolean;
	phase: "accepted" | "rejected";
	runtimeId?: string;
	pid?: number;
	sessionId?: string;
	sessionFile?: string;
	idle?: boolean;
	work?: "idle" | "starting" | "active";
	blocked?: boolean;
	error?: { code: string; message: string };
};

function isAuthorized(actual: unknown, expected: string): boolean {
	if (typeof actual !== "string") return false;
	const actualBytes = Buffer.from(actual);
	const expectedBytes = Buffer.from(expected);
	return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function isOperation(value: unknown): value is Operation {
	return ["probe", "submit", "steer", "abort", "request_human", "shutdown"].includes(String(value));
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag(CONTROL_SOCKET_FLAG, {
		description: "Prototype interactive Agent Run control socket",
		type: "string",
	});
	pi.registerFlag(CONTROL_TOKEN_FLAG, {
		description: "Prototype interactive Agent Run control token",
		type: "string",
	});

	let server: Server | undefined;
	let socketPath: string | undefined;
	let expectedToken: string | undefined;
	let runtimeId = randomUUID();
	let currentContext: ExtensionContext | undefined;
	let idle = true;
	let workStarting = false;
	let closing = false;
	let humanRequestController: AbortController | undefined;
	let humanRequestDone: Promise<void> | undefined;
	const clients = new Set<Socket>();

	function responseBase(requestId: string): ControlResponse {
		return {
			version: PROTOCOL_VERSION,
			id: requestId,
			ok: true,
			phase: "accepted",
			runtimeId,
			pid: process.pid,
			sessionId: currentContext?.sessionManager.getSessionId(),
			sessionFile: currentContext?.sessionManager.getSessionFile(),
			idle,
			work: workStarting ? "starting" : idle ? "idle" : "active",
			blocked: humanRequestController !== undefined,
		};
	}

	function reject(socket: Socket, requestId: string, code: string, message: string): void {
		const response: ControlResponse = {
			version: PROTOCOL_VERSION,
			id: requestId,
			ok: false,
			phase: "rejected",
			error: { code, message },
		};
		socket.end(`${JSON.stringify(response)}\n`);
	}

	function accept(socket: Socket, requestId: string, afterFlush?: () => void): void {
		socket.write(`${JSON.stringify(responseBase(requestId))}\n`, () => {
			socket.end();
			afterFlush?.();
		});
	}

	async function runHumanRequest(ctx: ExtensionContext, controller: AbortController): Promise<void> {
		pi.events.emit(BLOCKED_EVENT, {
			active: true,
			label: "Waiting for prototype Human Answer",
		});
		try {
			const answer = await ctx.ui.input(
				"Prototype Human Request",
				"Enter an answer in this Pi panel",
				{ signal: controller.signal },
			);
			if (!controller.signal.aborted) {
				ctx.ui.notify(answer ? `Answer received: ${answer}` : "Request cancelled", "info");
			}
		} finally {
			pi.events.emit(BLOCKED_EVENT, { active: false });
			if (humanRequestController === controller) {
				humanRequestController = undefined;
				humanRequestDone = undefined;
			}
		}
	}

	function startHumanRequest(ctx: ExtensionContext): void {
		const controller = new AbortController();
		humanRequestController = controller;
		humanRequestDone = runHumanRequest(ctx, controller);
		void humanRequestDone.catch((error) => {
			ctx.ui.notify(`Prototype Human Request failed: ${String(error)}`, "error");
		});
	}

	async function cancelHumanRequest(): Promise<void> {
		humanRequestController?.abort();
		await humanRequestDone;
	}

	function validateRequest(value: unknown): ControlRequest | undefined {
		if (!value || typeof value !== "object") return undefined;
		const request = value as Record<string, unknown>;
		if (
			request.version !== PROTOCOL_VERSION ||
			typeof request.id !== "string" ||
			request.id.length === 0 ||
			!isOperation(request.op)
		) {
			return undefined;
		}
		return request as ControlRequest;
	}

	function handleRequest(socket: Socket, value: unknown): void {
		const requestId =
			value && typeof value === "object" && typeof (value as Record<string, unknown>).id === "string"
				? String((value as Record<string, unknown>).id)
				: "unknown";
		const request = validateRequest(value);
		if (!request) {
			reject(socket, requestId, "bad_request", "Invalid control request");
			return;
		}
		if (!expectedToken || !isAuthorized(request.token, expectedToken)) {
			reject(socket, request.id, "unauthorized", "Invalid control token");
			return;
		}
		if (closing || !currentContext) {
			reject(socket, request.id, "runtime_closing", "Pi extension runtime is closing");
			return;
		}

		const ctx = currentContext;
		try {
			switch (request.op) {
				case "probe":
					accept(socket, request.id);
					return;
				case "submit":
					if (!idle || humanRequestController) {
						reject(socket, request.id, "not_idle", "Submit requires an idle Run without a Human Request");
						return;
					}
					if (typeof request.text !== "string" || request.text.trim().length === 0) {
						reject(socket, request.id, "bad_request", "Submit requires non-empty text");
						return;
					}
					idle = false;
					workStarting = true;
					try {
						pi.sendUserMessage(request.text);
					} catch (error) {
						idle = true;
						workStarting = false;
						throw error;
					}
					accept(socket, request.id);
					return;
				case "steer":
					if (workStarting) {
						reject(socket, request.id, "work_starting", "Steer requires agent_start confirmation");
						return;
					}
					if (idle || humanRequestController) {
						reject(socket, request.id, "not_active", "Steer requires confirmed active work");
						return;
					}
					if (typeof request.text !== "string" || request.text.trim().length === 0) {
						reject(socket, request.id, "bad_request", "Steer requires non-empty text");
						return;
					}
					pi.sendUserMessage(request.text, { deliverAs: "steer" });
					accept(socket, request.id);
					return;
				case "abort":
					if (workStarting) {
						reject(socket, request.id, "work_starting", "Abort requires agent_start confirmation");
						return;
					}
					if (idle) {
						reject(socket, request.id, "not_active", "Abort requires active work");
						return;
					}
					ctx.abort();
					accept(socket, request.id);
					return;
				case "request_human":
					if (!idle || humanRequestController) {
						reject(socket, request.id, "invalid_state", "Human Request requires an idle unblocked Run");
						return;
					}
					startHumanRequest(ctx);
					accept(socket, request.id);
					return;
				case "shutdown":
					if (!idle) {
						reject(socket, request.id, "work_active", "Abort and settle active work before shutdown");
						return;
					}
					closing = true;
					accept(socket, request.id, () => {
						void cancelHumanRequest().finally(() => ctx.shutdown());
					});
					return;
			}
		} catch (error) {
			reject(socket, request.id, "dispatch_failed", String(error));
		}
	}

	function handleConnection(socket: Socket): void {
		clients.add(socket);
		let requestBuffer = Buffer.alloc(0);
		let dispatched = false;
		socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
		socket.on("data", (chunk: Buffer) => {
			if (dispatched) return;
			requestBuffer = Buffer.concat([requestBuffer, chunk]);
			if (requestBuffer.length > MAX_REQUEST_BYTES) {
				dispatched = true;
				reject(socket, "unknown", "too_large", "Control request exceeds 64 KiB");
				return;
			}
			const newline = requestBuffer.indexOf(0x0a);
			if (newline < 0) return;
			dispatched = true;
			socket.setTimeout(0);
			const line = requestBuffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
			const trailing = requestBuffer.subarray(newline + 1).toString("utf8").trim();
			if (trailing.length > 0) {
				reject(socket, "unknown", "bad_request", "Only one request is allowed per connection");
				return;
			}
			try {
				handleRequest(socket, JSON.parse(line));
			} catch {
				reject(socket, "unknown", "bad_json", "Control request is not valid JSON");
			}
		});
		socket.on("close", () => clients.delete(socket));
		socket.on("error", () => clients.delete(socket));
	}

	async function startServer(ctx: ExtensionContext): Promise<void> {
		const configuredPath = pi.getFlag(CONTROL_SOCKET_FLAG);
		const configuredToken = pi.getFlag(CONTROL_TOKEN_FLAG);
		if (typeof configuredPath !== "string" || typeof configuredToken !== "string") {
			ctx.ui.setStatus("agent-run-prototype", "PROTOTYPE FAILED — missing control flags");
			return;
		}
		socketPath = configuredPath;
		expectedToken = configuredToken;
		server = createServer(handleConnection);
		await new Promise<void>((resolve, reject) => {
			server?.once("error", reject);
			server?.listen(socketPath, () => {
				server?.off("error", reject);
				resolve();
			});
		});
		await chmod(socketPath, 0o600);
		ctx.ui.setStatus("agent-run-prototype", "PROTOTYPE READY — interactive control attached");
	}

	async function stopServer(): Promise<void> {
		closing = true;
		for (const client of clients) client.destroy();
		clients.clear();
		const activeServer = server;
		server = undefined;
		if (activeServer) {
			await new Promise<void>((resolve) => activeServer.close(() => resolve()));
		}
		if (socketPath) {
			await unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
		}
		currentContext = undefined;
	}

	pi.registerCommand("prototype-request", {
		description: "Open a Human Request in the normal Pi panel",
		handler: async (_args, ctx) => {
			if (!idle || humanRequestController) {
				ctx.ui.notify("Human Request requires an idle unblocked Run", "warning");
				return;
			}
			startHumanRequest(ctx);
		},
	});

	pi.on("session_before_switch", (_event, ctx) => {
		ctx.ui.notify("Session switching is disabled while the prototype lease is held", "warning");
		return { cancel: true };
	});
	pi.on("session_before_fork", (_event, ctx) => {
		ctx.ui.notify("Session forking is disabled while the prototype lease is held", "warning");
		return { cancel: true };
	});
	pi.on("agent_start", () => {
		workStarting = false;
		idle = false;
	});
	pi.on("agent_settled", (_event, ctx) => {
		workStarting = false;
		idle = ctx.isIdle();
	});
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		closing = false;
		workStarting = false;
		idle = ctx.isIdle();
		currentContext = ctx;
		runtimeId = randomUUID();
		await startServer(ctx);
	});
	pi.on("session_shutdown", async () => {
		humanRequestController?.abort();
		await humanRequestDone;
		await stopServer();
	});
}
