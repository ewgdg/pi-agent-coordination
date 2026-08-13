import { randomBytes } from "node:crypto";
import { readFile, realpath, writeFile, unlink } from "node:fs/promises";
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
import {
	type ChildContextFile,
	materializeNewChildContextArtifact,
} from "./child-context-artifact.ts";
import { buildPiChildCliLaunch } from "./pi-child-cli-launch.ts";
import {
	dispatchParticipantRequestToOwner,
	type OwnerParticipantRequestHandlers,
} from "./remote-participant-control.ts";
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
const INPUT_EXTENSION_PATH = fileURLToPath(
	new URL("./child-runtime-input.ts", import.meta.url),
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
	agentsFiles: readonly ChildContextFile[];
	projectTrusted: boolean;
	agentDir?: string;
	ownerEnvironment?: NodeJS.ProcessEnv;
	runtimeDirectory?: string;
	columns?: number;
	rows?: number;
	startupTimeoutMilliseconds?: number;
	cliPath?: string;
	bridgeExtensionPath?: string;
	inputExtensionPath?: string;
	ownerRequestHandlers?:
		| OwnerParticipantRequestHandlers<"ordinary">
		| OwnerParticipantRequestHandlers<"moderator">;
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
		contextArtifactPath: string | undefined;
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
			if (options.contextArtifactPath) await unlinkIfExists(options.contextArtifactPath);
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
		return await (await this.launch(options)).ready();
	}

	static async launch(options: StartPiChildProcessRuntimeOptions): Promise<PiChildProcessLaunch> {
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
		const contextArtifactCandidatePath = join(dirname(listener.endpoint.address), "context.md");
		let contextArtifactPath: string | undefined;
		let projection: PtyTerminalProjection | undefined;
		let channel: PiChildRuntimeChannel | undefined;
		let cleanupPromise: Promise<void> | undefined;
		try {
			const bootstrap: ChildProcessBootstrap = {
				protocolVersion: AGENT_CONTROL_PROTOCOL_VERSION,
				endpoint: listener.endpoint,
				connectionToken: randomBytes(32).toString("hex"),
				workflowId: requireIdentity("workflowId", options.workflowId),
				agentId: requireIdentity("agentId", options.agentId),
				role: options.role,
				ownerPresentation: options.ownerRequestHandlers !== undefined,
				expectedSessionId: requireIdentity("expectedSessionId", options.expectedSessionId),
			};
			contextArtifactPath = await materializeNewChildContextArtifact({
				path: contextArtifactCandidatePath,
				agentsFiles: options.agentsFiles,
			});
			await writeFile(bootstrapPath, `${JSON.stringify(bootstrap)}\n`, {
				encoding: "utf8",
				mode: 0o600,
				flag: "wx",
			});
			const bridgeExtensionPath = options.bridgeExtensionPath ?? BRIDGE_EXTENSION_PATH;
			const inputExtensionPath = options.inputExtensionPath ?? INPUT_EXTENSION_PATH;
			const childLaunch = buildPiChildCliLaunch({
				cliPath: options.cliPath ?? resolveInstalledPiCliPath(),
				sessionPath: options.sessionPath,
				configuration: options.configuration,
				skillPaths: options.skillPaths,
				bridgeExtensionPath,
				inputExtensionPath,
				...(contextArtifactPath === undefined
					? {}
					: { contextArtifactPath }),
				projectTrusted: options.projectTrusted,
			});
			const ownerEnvironment = options.ownerEnvironment ?? process.env;
			const resolvedAgentDir = options.agentDir ?? ownerEnvironment.PI_CODING_AGENT_DIR;
			if (!resolvedAgentDir) {
				throw new Error(
					"invalid_child_runtime: parent PI_CODING_AGENT_DIR is required",
				);
			}
			const environment = buildChildProcessEnvironment({
				ownerEnvironment,
				bootstrapPath,
			});
			environment.PI_CODING_AGENT_DIR = resolvedAgentDir;
			environment.TERM = "xterm-256color";
			environment.COLORTERM = "truecolor";
			const eventHandlers = new Set<(event: PiChildRuntimeEvent) => void>();
			let settleReady!: (ready: PiChildRuntimeReady) => void;
			let rejectReady!: (error: Error) => void;
			const bridgeReady = new Promise<PiChildRuntimeReady>((resolve, reject) => {
				settleReady = resolve;
				rejectReady = reject;
			});
			// Control can settle either deferred before startup reaches its matching
			// await. Own both rejections immediately; launch.ready() remains the caller's
			// authoritative failure and cleanup boundary.
			void bridgeReady.catch(() => undefined);
			let rejectStartupFault!: (error: Error) => void;
			const startupFault = new Promise<never>((_resolve, reject) => {
				rejectStartupFault = reject;
			});
			void startupFault.catch(() => undefined);
			const admission = admissionBroker.admit(
				{
					agentId: bootstrap.agentId,
					connectionToken: bootstrap.connectionToken,
					expectedSessionId: bootstrap.expectedSessionId,
				},
				(candidate) => {
					candidate.onRequest((request) =>
						dispatchParticipantRequestToOwner(options.ownerRequestHandlers, request)
					);
					const removePresentationChangeHandler = options.ownerRequestHandlers
						?.presentation.addChangeHandler?.((snapshot) => {
							void candidate.sendEvent("presentation.agents.changed", {
								...snapshot,
								live: [...snapshot.live],
								dormant: [...snapshot.dormant],
								humanAttention: [...snapshot.humanAttention],
								operationalAttention: [...snapshot.operationalAttention],
							}).catch(() => undefined);
						}) ?? (() => undefined);
					candidate.onEvent((event) => {
						if (event.event === "runtime.ready") settleReady(event.payload);
						if (event.event === "runtime.fault") {
							rejectStartupFault(new Error(
								`child_runtime_fault: ${event.payload.code}: ${event.payload.message}`,
							));
						}
						for (const handler of eventHandlers) handler(event);
					});
					candidate.onClose((cause) => {
						removePresentationChangeHandler();
						rejectReady(cause);
					});
				},
			);
			void admission.catch(() => undefined);
			projection = spawnPtyTerminalProjection({
				file: childLaunch.command,
				arguments: childLaunch.arguments,
				cwd: childLaunch.cwd,
				environment,
				columns: options.columns ?? DEFAULT_COLUMNS,
				rows: options.rows ?? DEFAULT_ROWS,
			});
			const exactProjection = projection;
			const cleanup = () => {
				cleanupPromise ??= (async () => {
					await channel?.close().catch(() => undefined);
					forceKillProjection(exactProjection);
					await exactProjection.dispose().catch(() => undefined);
					await unlinkIfExists(bootstrapPath);
					if (contextArtifactPath) await unlinkIfExists(contextArtifactPath);
					await admissionBroker.close().catch(() => undefined);
				})();
				return cleanupPromise;
			};
			const timeoutMilliseconds = options.startupTimeoutMilliseconds
				?? DEFAULT_STARTUP_TIMEOUT_MILLISECONDS;
			return new PiChildProcessLaunch({
				projection: exactProjection,
				bootstrapPath,
				eventHandlers,
				cleanup,
				initialize: async (cancellation) => {
					try {
						channel = await raceStartup(
							Promise.race([admission, startupFault]),
							exactProjection,
							timeoutMilliseconds,
							"control admission",
							cancellation,
						);
						const readyPayload = await raceStartup(
							Promise.race([bridgeReady, startupFault]),
							exactProjection,
							timeoutMilliseconds,
							"runtime.ready",
							cancellation,
						);
						if (readyPayload.sessionId !== bootstrap.expectedSessionId) {
							throw new Error(
								`child_runtime_ready_mismatch: expected session ${bootstrap.expectedSessionId}, received ${readyPayload.sessionId}`,
							);
						}
						const snapshot = await raceStartup(
							Promise.race([channel.request("runtime.snapshot", {}), startupFault]),
							exactProjection,
							timeoutMilliseconds,
							"configuration snapshot",
							cancellation,
						);
						await assertRuntimeSnapshot(
							snapshot,
							options.configuration,
							options.skillPaths,
							options.projectTrusted,
							bootstrap.expectedSessionId,
							options.sessionPath,
							contextArtifactPath,
						);
						return new PiChildProcessRuntime({
							projection: exactProjection,
							admissionBroker,
							channel,
							ready: readyPayload,
							snapshot,
							bootstrapPath,
							contextArtifactPath,
							eventHandlers,
						});
					} catch (error) {
						throw await withTerminalDiagnostic(error, exactProjection);
					}
				},
			});
		} catch (error) {
			await channel?.close().catch(() => undefined);
			if (projection) forceKillProjection(projection);
			await projection?.dispose().catch(() => undefined);
			await unlinkIfExists(bootstrapPath);
			await unlinkIfExists(contextArtifactCandidatePath);
			await admissionBroker.close().catch(() => undefined);
			throw error;
		}
	}

	get pid(): number {
		return this.#projection.pid;
	}

	frame(): TerminalProjectionFrame {
		return this.#projection.frame();
	}

	addChangeHandler(handler: () => void): () => void {
		return this.#projection.addChangeHandler(handler);
	}

	addFailureHandler(handler: (error: unknown) => void): () => void {
		return this.#projection.addFailureHandler(handler);
	}

	addOutputHandler(handler: (data: string) => void): () => void {
		return this.#projection.addOutputHandler(handler);
	}

	setPhysicalTerminalAttached(attached: boolean): void {
		this.#projection.setPhysicalTerminalAttached(attached);
	}

	pauseOutput(): void {
		this.#projection.pauseOutput();
	}

	resumeOutput(): void {
		this.#projection.resumeOutput();
	}

	reinitializePresentation(): Promise<void> {
		return this.channel.request("presentation.reinitialize", {}).then(() => undefined);
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
		// The grace period bounds the complete exchange. A wedged child may keep the
		// Control request pending forever, before process-exit waiting even begins.
		const gracefulExit = await withTimeout((async () => {
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
			return await this.exited;
		})(), graceMilliseconds);
		if (gracefulExit) return gracefulExit;
		forceKillProjection(this.#projection);
		return await this.exited;
	}

	#finalize(): Promise<void> {
		this.#cleanupPromise ??= this.#cleanup();
		return this.#cleanupPromise;
	}
}

type PiChildProcessLaunchState =
	| Readonly<{ kind: "pending" }>
	| Readonly<{ kind: "admitted"; runtime: PiChildProcessRuntime }>
	| Readonly<{ kind: "cancelled"; error: unknown }>
	| Readonly<{ kind: "failed" }>;

/** Real child PTY and exact admission settlement exposed before Runtime readiness. */
export class PiChildProcessLaunch {
	readonly #projection: PtyTerminalProjection;
	readonly #eventHandlers: Set<(event: PiChildRuntimeEvent) => void>;
	readonly #cleanupInitialization: () => Promise<void>;
	readonly #readiness: Promise<PiChildProcessRuntime>;
	#rejectCancellation!: (error: unknown) => void;
	#state: PiChildProcessLaunchState = { kind: "pending" };
	#cleanupPromise: Promise<void> | undefined;
	#disposePromise: Promise<void> | undefined;
	#disposed = false;
	readonly bootstrapPath: string;
	readonly exited: Promise<PtyExit>;

	constructor(options: {
		projection: PtyTerminalProjection;
		bootstrapPath: string;
		eventHandlers: Set<(event: PiChildRuntimeEvent) => void>;
		cleanup(): Promise<void>;
		initialize(cancellation: Promise<never>): Promise<PiChildProcessRuntime>;
	}) {
		this.#projection = options.projection;
		this.bootstrapPath = options.bootstrapPath;
		this.#eventHandlers = options.eventHandlers;
		this.#cleanupInitialization = options.cleanup;
		this.exited = options.projection.exited;
		const cancellation = new Promise<never>((_resolve, reject) => {
			this.#rejectCancellation = reject;
		});
		this.#readiness = options.initialize(cancellation).then(
			(runtime) => {
				if (this.#state.kind !== "pending") {
					throw this.#state.kind === "cancelled"
						? this.#state.error
						: new Error("child_runtime_launch_not_pending");
				}
				this.#state = { kind: "admitted", runtime };
				return runtime;
			},
			async (error) => {
				const rejection = this.#state.kind === "cancelled"
					? this.#state.error
					: error;
				if (this.#state.kind === "pending") this.#state = { kind: "failed" };
				await this.#beginInitializationCleanup().catch(() => undefined);
				throw rejection;
			},
		);
		void this.#readiness.catch(() => undefined);
	}

	get pid(): number {
		return this.#projection.pid;
	}

	get disposed(): boolean {
		return this.#disposed;
	}

	frame(): TerminalProjectionFrame {
		return this.#projection.frame();
	}

	addChangeHandler(handler: () => void): () => void {
		return this.#projection.addChangeHandler(handler);
	}

	addFailureHandler(handler: (error: unknown) => void): () => void {
		return this.#projection.addFailureHandler(handler);
	}

	addOutputHandler(handler: (data: string) => void): () => void {
		return this.#projection.addOutputHandler(handler);
	}

	setPhysicalTerminalAttached(attached: boolean): void {
		this.#projection.setPhysicalTerminalAttached(attached);
	}

	pauseOutput(): void {
		this.#projection.pauseOutput();
	}

	resumeOutput(): void {
		this.#projection.resumeOutput();
	}

	reinitializePresentation(): Promise<void> {
		return this.#readiness.then((runtime) => runtime.reinitializePresentation());
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

	ready(): Promise<PiChildProcessRuntime> {
		return this.#readiness;
	}

	cancelInitialization(error: unknown): Promise<void> | undefined {
		if (this.#state.kind !== "pending") return undefined;
		this.#state = { kind: "cancelled", error };
		const cleanup = this.#beginInitializationCleanup();
		this.#rejectCancellation(error);
		return cleanup;
	}

	dispose(): Promise<void> {
		this.#disposePromise ??= this.#dispose();
		return this.#disposePromise;
	}

	#beginInitializationCleanup(): Promise<void> {
		this.#cleanupPromise ??= this.#cleanupInitialization().finally(() => {
			this.#disposed = true;
		});
		return this.#cleanupPromise;
	}

	async #dispose(): Promise<void> {
		if (this.#state.kind === "pending") {
			await this.cancelInitialization(new Error("child runtime launch disposed"));
			return;
		}
		if (this.#state.kind === "admitted") {
			await this.#state.runtime.dispose();
			this.#disposed = true;
			return;
		}
		await this.#beginInitializationCleanup();
	}
}

export function resolveInstalledPiCliPath(): string {
	return join(getPackageDir(), "dist", "cli.js");
}

async function assertRuntimeSnapshot(
	actual: PiChildRuntimeSnapshot,
	expected: EffectiveAgentRunConfiguration,
	skillPaths: readonly string[],
	projectTrusted: boolean,
	expectedSessionId: string,
	sessionPath: string,
	contextArtifactPath: string | undefined,
): Promise<void> {
	assertToolExecutionModes(actual, expected.tools);
	const expectedSnapshot: PiChildRuntimeSnapshot = {
		cwd: expected.cwd,
		model: expected.model,
		thinking: expected.thinking,
		tools: [...expected.tools],
		skills: [...expected.skills],
		skillSources: await Promise.all(expected.skills.map(async (name, index) => ({
			name,
			filePath: await realpath(skillPaths[index]!),
		}))),
		extensions: await Promise.all(expected.extensions.map((path) => realpath(path))),
		toolExecutionModes: [...actual.toolExecutionModes],
		projectTrusted,
		sessionId: expectedSessionId,
		sessionPath,
		projectContext: contextArtifactPath === undefined
			? null
			: {
				filePath: await realpath(contextArtifactPath),
				body: await readFile(contextArtifactPath, "utf8"),
			},
	};
	if (JSON.stringify(actual) !== JSON.stringify(expectedSnapshot)) {
		throw new Error(
			`child_runtime_configuration_mismatch: expected ${JSON.stringify(expectedSnapshot)}, received ${JSON.stringify(actual)}`,
		);
	}
}

function assertToolExecutionModes(
	actual: PiChildRuntimeSnapshot,
	expectedTools: readonly string[],
): void {
	const modeNames = actual.toolExecutionModes.map(({ name }) => name);
	if (JSON.stringify(modeNames) !== JSON.stringify(expectedTools)) {
		throw new Error(
			`child_runtime_tool_modes_mismatch: expected ${JSON.stringify(expectedTools)}, received ${JSON.stringify(modeNames)}`,
		);
	}
}

async function raceStartup<T>(
	operation: Promise<T>,
	projection: PtyTerminalProjection,
	timeoutMilliseconds: number,
	stage: string,
	cancellation?: Promise<never>,
): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			operation,
			...(cancellation === undefined ? [] : [cancellation]),
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

async function withTerminalDiagnostic(
	error: unknown,
	projection: PtyTerminalProjection,
): Promise<Error> {
	let terminalDiagnostic = "";
	if (!projection.disposed) {
		await projection.drain().catch(() => undefined);
		try {
			terminalDiagnostic = projection.frame().lines
				.map((line) => line.text)
				.filter((line) => line.length > 0)
				.join("\n");
		} catch {
			// Concurrent cancellation can finish PTY cleanup before diagnostics render.
		}
	}
	const cause = error instanceof Error ? error : new Error(String(error));
	return terminalDiagnostic.length === 0
		? cause
		: new Error(`${cause.message}\nChild terminal:\n${terminalDiagnostic}`, { cause });
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
		projection.killProcessGroup("SIGKILL");
	} catch {
		// A concurrent group exit is success; exact leader settlement is observed via exited.
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
