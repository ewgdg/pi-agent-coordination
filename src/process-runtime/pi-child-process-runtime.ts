import { randomBytes } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getPackageDir } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";

import { AgentControlAdmissionBroker } from "../control/agent-control-admission.ts";
import {
	FramedAgentControlChannel,
	type ControlEvent,
} from "../control/agent-control-channel.ts";
import {
	agentControlProtocol,
	RuntimeSnapshotSchema,
} from "../control/agent-control-protocol.ts";
import { createPlatformControlListener } from "../control/control-platform.ts";
import {
	AGENT_CONTROL_PROTOCOL_VERSION,
	type ChildProcessBootstrap,
} from "../control/control-protocol-schemas.ts";
import type { EffectiveAgentRunConfiguration } from "../templates/agent-configuration.ts";
import {
	buildChildProcessEnvironment,
} from "./child-process-environment.ts";
import { buildPiChildCliLaunch } from "./pi-child-cli-launch.ts";
import {
	spawnPtyTerminalProjection,
	type PtyExit,
	type PtyTerminalProjection,
	type TerminalProjectionFrame,
} from "./pty-terminal-projection.ts";

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_STARTUP_TIMEOUT_MILLISECONDS = 15_000;
const DEFAULT_SHUTDOWN_GRACE_MILLISECONDS = 3_000;
const BRIDGE_EXTENSION_PATH = fileURLToPath(
	new URL("./child-runtime-bridge.ts", import.meta.url),
);

export type PiChildRuntimeSnapshot = Static<typeof RuntimeSnapshotSchema>;
export type PiChildRuntimeReady = Readonly<{
	sessionId: string;
	mode: "tui";
	hasUI: true;
}>;
export type PiChildRuntimeEvent = ControlEvent<typeof agentControlProtocol>;
export type PiChildRuntimeChannel = FramedAgentControlChannel<typeof agentControlProtocol>;

export type StartPiChildProcessRuntimeOptions = Readonly<{
	workflowId: string;
	agentId: string;
	role: ChildProcessBootstrap["role"];
	expectedSessionId: string;
	sessionPath: string;
	configuration: EffectiveAgentRunConfiguration;
	skillPaths: readonly string[];
	projectTrusted: boolean;
	projectContextPath?: string;
	ownerEnvironment?: NodeJS.ProcessEnv;
	runtimeDirectory?: string;
	columns?: number;
	rows?: number;
	startupTimeoutMilliseconds?: number;
	cliPath?: string;
	bridgeExtensionPath?: string;
}>;

/** Standalone Owner-side host for one real Pi CLI/TUI process. */
export class PiChildProcessRuntime {
	readonly #projection: PtyTerminalProjection;
	readonly #admissionBroker: AgentControlAdmissionBroker<typeof agentControlProtocol>;
	readonly #eventHandlers: Set<(event: PiChildRuntimeEvent) => void>;
	readonly #cleanup: () => Promise<void>;
	#cleanupPromise: Promise<void> | undefined;
	#shutdownPromise: Promise<PtyExit> | undefined;
	#exitResult: PtyExit | undefined;
	#exitObserved = false;
	#channelClosed = false;

	readonly channel: PiChildRuntimeChannel;
	readonly ready: PiChildRuntimeReady;
	readonly snapshot: PiChildRuntimeSnapshot;
	readonly bootstrapPath: string;
	readonly exited: Promise<PtyExit>;

	private constructor(options: {
		projection: PtyTerminalProjection;
		admissionBroker: AgentControlAdmissionBroker<typeof agentControlProtocol>;
		channel: PiChildRuntimeChannel;
		ready: PiChildRuntimeReady;
		snapshot: PiChildRuntimeSnapshot;
		bootstrapPath: string;
		eventHandlers: Set<(event: PiChildRuntimeEvent) => void>;
	}) {
		this.#projection = options.projection;
		this.#admissionBroker = options.admissionBroker;
		this.#eventHandlers = options.eventHandlers;
		this.channel = options.channel;
		this.ready = options.ready;
		this.snapshot = options.snapshot;
		this.bootstrapPath = options.bootstrapPath;
		this.#cleanup = async () => {
			await this.channel.close().catch(() => undefined);
			await unlinkIfExists(this.bootstrapPath);
			await this.#admissionBroker.close().catch(() => undefined);
			await this.#projection.dispose().catch(() => undefined);
		};
		this.exited = this.#projection.exited.then(async (exit) => {
			this.#exitObserved = true;
			this.#exitResult = exit;
			await this.#finalize();
			return exit;
		});
		this.channel.onClose(() => {
			this.#channelClosed = true;
			if (this.#exitObserved) return;
			const forceCleanup = setTimeout(() => {
				if (!this.#exitObserved) forceKillProjection(this.#projection);
			}, DEFAULT_SHUTDOWN_GRACE_MILLISECONDS);
			forceCleanup.unref();
		});
	}

	static async start(options: StartPiChildProcessRuntimeOptions): Promise<PiChildProcessRuntime> {
		const listener = await createPlatformControlListener({
			workflowId: options.workflowId,
			...(options.runtimeDirectory === undefined
				? {}
				: { runtimeDirectory: options.runtimeDirectory }),
		});
		const admissionBroker = new AgentControlAdmissionBroker({
			listener,
			protocol: agentControlProtocol,
			workflowId: options.workflowId,
		});
		const bootstrapPath = join(dirname(listener.endpoint.address), "bootstrap.json");
		const bootstrap: ChildProcessBootstrap = {
			protocolVersion: AGENT_CONTROL_PROTOCOL_VERSION,
			endpoint: listener.endpoint,
			connectionToken: randomBytes(32).toString("hex"),
			workflowId: requireIdentity("workflowId", options.workflowId),
			agentId: requireIdentity("agentId", options.agentId),
			role: options.role,
			expectedSessionId: requireIdentity("expectedSessionId", options.expectedSessionId),
		};
		let projection: PtyTerminalProjection | undefined;
		let channel: PiChildRuntimeChannel | undefined;
		const eventHandlers = new Set<(event: PiChildRuntimeEvent) => void>();
		let settleReady!: (ready: PiChildRuntimeReady) => void;
		let rejectReady!: (error: Error) => void;
		const ready = new Promise<PiChildRuntimeReady>((resolve, reject) => {
			settleReady = resolve;
			rejectReady = reject;
		});
		let rejectStartupFault!: (error: Error) => void;
		const startupFault = new Promise<never>((_resolve, reject) => {
			rejectStartupFault = reject;
		});
		try {
			await writeFile(bootstrapPath, `${JSON.stringify(bootstrap)}\n`, {
				encoding: "utf8",
				mode: 0o600,
				flag: "wx",
			});
			const bridgeExtensionPath = options.bridgeExtensionPath ?? BRIDGE_EXTENSION_PATH;
			const launch = buildPiChildCliLaunch({
				cliPath: options.cliPath ?? resolveInstalledPiCliPath(),
				sessionPath: options.sessionPath,
				configuration: options.configuration,
				skillPaths: options.skillPaths,
				bridgeExtensionPath,
				...(options.projectContextPath === undefined
					? {}
					: { projectContextPath: options.projectContextPath }),
				projectTrusted: options.projectTrusted,
			});
			const environment = buildChildProcessEnvironment({
				ownerEnvironment: options.ownerEnvironment ?? process.env,
				bootstrapPath,
			});
			environment.TERM = "xterm-256color";
			environment.COLORTERM = "truecolor";
			const timeoutMilliseconds = options.startupTimeoutMilliseconds
				?? DEFAULT_STARTUP_TIMEOUT_MILLISECONDS;
			const admission = admissionBroker.admit(
				{
					agentId: bootstrap.agentId,
					connectionToken: bootstrap.connectionToken,
					expectedSessionId: bootstrap.expectedSessionId,
				},
				(candidate) => {
					candidate.onRequest(() => {
						throw new Error("child_runtime_owner_request_unavailable");
					});
					candidate.onEvent((event) => {
						if (event.event === "runtime.ready") settleReady(event.payload);
						if (event.event === "runtime.fault") {
							rejectStartupFault(new Error(
								`child_runtime_fault: ${event.payload.code}: ${event.payload.message}`,
							));
						}
						for (const handler of eventHandlers) handler(event);
					});
					candidate.onClose((cause) => rejectReady(cause));
				},
			);
			// Register the one-time token before the child can connect.
			void admission.catch(() => undefined);
			projection = spawnPtyTerminalProjection({
				file: launch.command,
				arguments: launch.arguments,
				cwd: launch.cwd,
				environment,
				columns: options.columns ?? DEFAULT_COLUMNS,
				rows: options.rows ?? DEFAULT_ROWS,
			});
			channel = await raceStartup(
				admission,
				projection,
				timeoutMilliseconds,
				"control admission",
			);
			const readyPayload = await raceStartup(ready, projection, timeoutMilliseconds, "runtime.ready");
			if (readyPayload.sessionId !== bootstrap.expectedSessionId) {
				throw new Error(
					`child_runtime_ready_mismatch: expected session ${bootstrap.expectedSessionId}, received ${readyPayload.sessionId}`,
				);
			}
			const snapshot = await raceStartup(
				Promise.race([channel.request("runtime.snapshot", {}), startupFault]),
				projection,
				timeoutMilliseconds,
				"configuration snapshot",
			);
			assertRuntimeSnapshot(snapshot, options.configuration, bootstrap.expectedSessionId);
			return new PiChildProcessRuntime({
				projection,
				admissionBroker,
				channel,
				ready: readyPayload,
				snapshot,
				bootstrapPath,
				eventHandlers,
			});
		} catch (error) {
			let terminalDiagnostic = "";
			if (projection && !projection.disposed) {
				await projection.drain().catch(() => undefined);
				terminalDiagnostic = projection.frame().lines
					.map((line) => line.text)
					.filter((line) => line.length > 0)
					.join("\n");
			}
			await channel?.close().catch(() => undefined);
			if (projection) forceKillProjection(projection);
			await projection?.dispose().catch(() => undefined);
			await unlinkIfExists(bootstrapPath);
			await admissionBroker.close().catch(() => undefined);
			const cause = error instanceof Error ? error : new Error(String(error));
			throw terminalDiagnostic.length === 0
				? cause
				: new Error(`${cause.message}\nChild terminal:\n${terminalDiagnostic}`, { cause });
		}
	}

	get pid(): number {
		return this.#projection.pid;
	}

	frame(): TerminalProjectionFrame {
		return this.#projection.frame();
	}

	writeInput(data: string | Buffer): void {
		this.#projection.writeInput(data);
	}

	resize(columns: number, rows: number): void {
		this.#projection.resize(columns, rows);
	}

	drain(): Promise<void> {
		return this.#projection.drain();
	}

	onEvent(handler: (event: PiChildRuntimeEvent) => void): () => void {
		this.#eventHandlers.add(handler);
		return () => this.#eventHandlers.delete(handler);
	}

	prompt(payload: Readonly<{
		runId: string;
		input: string;
		kind: "initial" | "successor";
	}>) {
		return this.channel.request("run.prompt", payload);
	}

	shutdown(
		reason?: string,
		graceMilliseconds = DEFAULT_SHUTDOWN_GRACE_MILLISECONDS,
	): Promise<PtyExit> {
		this.#shutdownPromise ??= this.#shutdown(reason, graceMilliseconds);
		return this.#shutdownPromise;
	}

	async dispose(): Promise<void> {
		if (this.#exitResult) {
			await this.#finalize();
			return;
		}
		await this.shutdown("runtime disposed").catch(() => undefined);
		await this.#finalize();
	}

	async #shutdown(reason: string | undefined, graceMilliseconds: number): Promise<PtyExit> {
		if (!Number.isSafeInteger(graceMilliseconds) || graceMilliseconds < 1) {
			throw new Error("invalid_child_runtime_shutdown_grace: expected a positive integer");
		}
		if (!this.#channelClosed) {
			await this.channel.request("runtime.shutdown", {
				...(reason === undefined ? {} : { reason }),
			}).catch(() => undefined);
		} else {
			// If structured control is already unavailable, the native command is the
			// last graceful path before the exact process is forcibly terminated.
			try {
				this.#projection.writeInput("/quit\r");
			} catch {
				// The exit may have won the race; the exact exited Promise settles below.
			}
		}
		const gracefulExit = await withTimeout(this.exited, graceMilliseconds);
		if (gracefulExit) return gracefulExit;
		forceKillProjection(this.#projection);
		return await this.exited;
	}

	#finalize(): Promise<void> {
		this.#cleanupPromise ??= this.#cleanup();
		return this.#cleanupPromise;
	}
}

export function resolveInstalledPiCliPath(): string {
	return join(getPackageDir(), "dist", "cli.js");
}

function assertRuntimeSnapshot(
	actual: PiChildRuntimeSnapshot,
	expected: EffectiveAgentRunConfiguration,
	expectedSessionId: string,
): void {
	const expectedSnapshot: PiChildRuntimeSnapshot = {
		cwd: expected.cwd,
		model: expected.model,
		thinking: expected.thinking,
		tools: [...expected.tools],
		skills: [...expected.skills],
		extensions: [...expected.extensions],
		sessionId: expectedSessionId,
	};
	if (JSON.stringify(actual) !== JSON.stringify(expectedSnapshot)) {
		throw new Error(
			`child_runtime_configuration_mismatch: expected ${JSON.stringify(expectedSnapshot)}, received ${JSON.stringify(actual)}`,
		);
	}
}

async function raceStartup<T>(
	operation: Promise<T>,
	projection: PtyTerminalProjection,
	timeoutMilliseconds: number,
	stage: string,
): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			operation,
			projection.exited.then((exit) => {
				throw new Error(
					`child_runtime_early_exit: ${stage} ended with code ${exit.exitCode} signal ${exit.signal}`,
				);
			}),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error(`child_runtime_startup_timeout: waiting for ${stage}`)),
					timeoutMilliseconds,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T | undefined> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), milliseconds);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function forceKillProjection(projection: PtyTerminalProjection): void {
	try {
		projection.kill("SIGKILL");
	} catch {
		// A concurrent exit is success for cleanup; exact settlement is observed via exited.
	}
}

function requireIdentity(field: string, value: string): string {
	if (value.length === 0) throw new Error(`invalid_child_runtime: ${field} is required`);
	return value;
}

async function unlinkIfExists(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (error) {
		if (!hasCode(error, "ENOENT")) throw error;
	}
}

function hasCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error
		&& (error as NodeJS.ErrnoException).code === code;
}
