import * as hostPi from "@earendil-works/pi-coding-agent";
import type {
	AgentSessionRuntime,
	ExtensionContext,
	ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { FramedAgentControlChannel } from "../control/agent-control-channel.ts";
import { agentControlProtocol } from "../control/agent-control-protocol.ts";
import { connectControlTransport } from "../control/control-platform.ts";
import {
	AGENT_CONTROL_PROTOCOL_VERSION,
	type ChildProcessBootstrap,
	validateChildProcessBootstrap,
} from "../control/control-protocol-schemas.ts";
import { installInteractiveHostBridge } from "../pi-integration/interactive-host-bridge.ts";
import { CHILD_PROCESS_BOOTSTRAP_ENVIRONMENT_VARIABLE } from "./child-process-environment.ts";

const ENTRY_MODULE_PATH = import.meta.filename;

type ChildChannel = FramedAgentControlChannel<typeof agentControlProtocol>;

type RuntimeState = {
	channel: ChildChannel;
	context: ExtensionContext;
	runtime: AgentSessionRuntime;
	currentRunId?: string;
	shutdownStarted: boolean;
};

const childRuntimeBridge: ExtensionFactory = async (pi) => {
	const bootstrap = await readBootstrapDescriptor();
	const interactiveBridge = installInteractiveHostBridge(hostPi);
	let state: RuntimeState | undefined;

	pi.on("session_start", async (_event, ctx) => {
		if (state) throw new Error("child_runtime_bridge_rebound: session replacement is not supported");
		if (ctx.mode !== "tui" || !ctx.hasUI) {
			throw new Error("child_runtime_bridge_requires_tui: expected mode=tui and hasUI=true");
		}
		const transport = await connectControlTransport(bootstrap.endpoint);
		const channel = new FramedAgentControlChannel({
			identity: {
				protocolVersion: AGENT_CONTROL_PROTOCOL_VERSION,
				workflowId: bootstrap.workflowId,
				agentId: bootstrap.agentId,
			},
			protocol: agentControlProtocol,
			transport,
		});
		const capture = await interactiveBridge.capture(ctx.sessionManager as hostPi.SessionManager);
		state = {
			channel,
			context: ctx,
			runtime: capture.runtime,
			shutdownStarted: false,
		};
		channel.onRequest((request) => handleOwnerRequest(state as RuntimeState, request));
		channel.onEvent(() => undefined);
		channel.onClose(() => {
			const current = state;
			if (!current || current.shutdownStarted) return;
			current.shutdownStarted = true;
			current.context.shutdown();
		});
		try {
			assertExpectedSession(state.runtime, bootstrap);
			await channel.sendHello({
				connectionToken: bootstrap.connectionToken,
				expectedSessionId: bootstrap.expectedSessionId,
			});
			await channel.sendEvent("runtime.ready", {
				sessionId: ctx.sessionManager.getSessionId(),
				mode: "tui",
				hasUI: true,
			});
		} catch (error) {
			await reportFault(channel, "runtime_startup_failed", error);
			await channel.close().catch(() => undefined);
			throw error;
		}
	});

	pi.on("agent_start", async () => {
		const current = requireState(state);
		if (!current.currentRunId) {
			await reportFault(current.channel, "run_identity_missing", new Error("Pi started without an admitted run"));
			return;
		}
		await current.channel.sendEvent("agent.start", { runId: current.currentRunId });
	});
	pi.on("agent_end", async () => {
		const current = requireState(state);
		if (!current.currentRunId) return;
		await current.channel.sendEvent("agent.end", {
			runId: current.currentRunId,
			outcome: "completed",
		});
	});
	pi.on("agent_settled", async () => {
		const current = requireState(state);
		if (!current.currentRunId) return;
		const runId = current.currentRunId;
		await current.channel.sendEvent("agent.settled", {
			runId,
			outcome: "completed",
		});
		if (current.currentRunId === runId) current.currentRunId = undefined;
	});
	pi.on("model_select", async () => sendConfigurationChanged(state));
	pi.on("thinking_level_select", async () => sendConfigurationChanged(state));
	pi.on("session_info_changed", async (_event, ctx) => {
		const current = requireState(state);
		await current.channel.sendEvent("session.infoChanged", {
			sessionId: ctx.sessionManager.getSessionId(),
		});
	});
	pi.on("session_shutdown", async (event) => {
		const current = state;
		if (!current) return;
		current.shutdownStarted = true;
		await current.channel.sendEvent("session.shutdown", { reason: event.reason })
			.catch(() => undefined);
	});
};

async function handleOwnerRequest(
	state: RuntimeState,
	request: Parameters<Parameters<ChildChannel["onRequest"]>[0]>[0],
): Promise<unknown> {
	switch (request.method) {
		case "runtime.snapshot":
			return runtimeSnapshot(state.runtime);
		case "run.prompt": {
			if (state.currentRunId) {
				throw new Error(`child_runtime_busy: run ${state.currentRunId} is still admitted`);
			}
			state.currentRunId = request.payload.runId;
			let resolvePreflight!: (accepted: boolean) => void;
			const preflight = new Promise<boolean>((resolve) => {
				resolvePreflight = resolve;
			});
			void state.runtime.session.prompt(request.payload.input, {
				source: "extension",
				preflightResult: resolvePreflight,
			}).catch(async (error: unknown) => {
				await failCurrentRun(state, request.payload.runId, error);
			});
			const accepted = await preflight;
			if (!accepted && state.currentRunId === request.payload.runId) {
				state.currentRunId = undefined;
			}
			return { accepted };
		}
		case "runtime.shutdown":
			state.shutdownStarted = true;
			setImmediate(() => state.context.shutdown());
			return { accepted: true };
		default:
			throw new Error(`child_runtime_method_unavailable: ${request.method}`);
	}
}

function runtimeSnapshot(runtime: AgentSessionRuntime) {
	const session = runtime.session;
	const bridgePath = canonicalExtensionPath(ENTRY_MODULE_PATH);
	return {
		cwd: runtime.cwd,
		model: requireModel(session.model),
		thinking: session.thinkingLevel,
		tools: session.getActiveToolNames(),
		skills: runtime.services.resourceLoader.getSkills().skills.map(({ name }) => name),
		extensions: runtime.services.resourceLoader.getExtensions().extensions
			.map((extension) => extension.resolvedPath)
			.filter((path) => !path.startsWith("<inline:") && canonicalExtensionPath(path) !== bridgePath),
		sessionId: session.sessionId,
	};
}

function requireModel(model: AgentSessionRuntime["session"]["model"]) {
	if (!model) throw new Error("child_runtime_model_unavailable: no active model");
	return { provider: model.provider, modelId: model.id };
}

function canonicalExtensionPath(path: string): string {
	return isAbsolute(path) ? path : new URL(path, import.meta.url).pathname;
}

async function sendConfigurationChanged(state: RuntimeState | undefined): Promise<void> {
	const current = requireState(state);
	await current.channel.sendEvent("runtime.configurationChanged", runtimeSnapshot(current.runtime));
}

async function failCurrentRun(state: RuntimeState, runId: string, error: unknown): Promise<void> {
	await reportFault(state.channel, "run_prompt_failed", error);
	if (state.currentRunId !== runId) return;
	await state.channel.sendEvent("agent.end", {
		runId,
		outcome: "failed",
		error: errorMessage(error),
	}).catch(() => undefined);
	await state.channel.sendEvent("agent.settled", { runId, outcome: "failed" })
		.catch(() => undefined);
	if (state.currentRunId === runId) state.currentRunId = undefined;
}

async function reportFault(channel: ChildChannel, code: string, error: unknown): Promise<void> {
	await channel.sendEvent("runtime.fault", { code, message: errorMessage(error) })
		.catch(() => undefined);
}

function assertExpectedSession(runtime: AgentSessionRuntime, bootstrap: ChildProcessBootstrap): void {
	if (runtime.session.sessionId !== bootstrap.expectedSessionId) {
		throw new Error(
			`child_runtime_session_mismatch: expected ${bootstrap.expectedSessionId}, received ${runtime.session.sessionId}`,
		);
	}
}

async function readBootstrapDescriptor(): Promise<ChildProcessBootstrap> {
	const path = process.env[CHILD_PROCESS_BOOTSTRAP_ENVIRONMENT_VARIABLE];
	if (!path || !isAbsolute(path) || path.includes("\0")) {
		throw new Error("control_bootstrap_invalid: descriptor path must be absolute");
	}
	const descriptorStats = await stat(path);
	if (!descriptorStats.isFile()) {
		throw new Error("control_bootstrap_invalid: descriptor path is not a regular file");
	}
	if ((descriptorStats.mode & 0o077) !== 0) {
		throw new Error("control_bootstrap_invalid: descriptor must be owner-only");
	}
	let value: unknown;
	try {
		value = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		throw new Error(`control_bootstrap_invalid: ${errorMessage(error)}`);
	}
	return validateChildProcessBootstrap(value);
}

function requireState(state: RuntimeState | undefined): RuntimeState {
	if (!state) throw new Error("child_runtime_unavailable: bridge is not connected");
	return state;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default childRuntimeBridge;
