import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
	CustomEditor,
	InteractiveMode,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";

import piAgentCoordination from "../../src/index.ts";
import { createUnboundTestOwnerHost } from "../support/pi-host.ts";

const OWNER_EDITOR_TEXT = "Owner input survives child UI failure";
const failureKind = process.env.PTY_AGENT_VIEW_FAILURE;
if (
	failureKind !== "input" &&
	failureKind !== "render" &&
	failureKind !== "initialization" &&
	failureKind !== "run" &&
	failureKind !== "noninteractive"
) {
	throw new Error(`Unsupported PTY Agent-view failure: ${failureKind ?? "missing"}`);
}

let ownerSessionId = "";
let childSessionShutdowns = 0;
class FailingChildEditor extends CustomEditor {
	#renderFailureArmed = false;

	override handleInput(data: string): void {
		if (data === "x" && failureKind === "input") {
			throw new Error("deterministic PTY child input failure");
		}
		if (data === "x" && failureKind === "render") {
			this.#renderFailureArmed = true;
			return;
		}
		super.handleInput(data);
	}

	override render(width: number): string[] {
		if (this.#renderFailureArmed) {
			throw new Error("deterministic PTY child render failure");
		}
		return super.render(width);
	}
}

const host = await createUnboundTestOwnerHost(piAgentCoordination, {
	persistent: true,
	additionalExtensionFactories: [{
		name: "pty-child-ui-failure",
		hidden: true,
		factory(pi) {
			let childSession = false;
			pi.on("session_start", (_event, ctx) => {
				if (ctx.sessionManager.getSessionId() === ownerSessionId) return;
				childSession = true;
				ctx.ui.setEditorComponent((tui, theme, keybindings) =>
					new FailingChildEditor(tui, theme, keybindings)
				);
			});
			pi.on("session_shutdown", () => {
				if (childSession) childSessionShutdowns += 1;
			});
		},
	}],
});
const ownerSession = host.session;
ownerSessionId = ownerSession.sessionId;
const mode = new InteractiveMode(host.runtime, {
	verbose: false,
	tuiMode: "fullscreen",
});
await mode.init();
void mode.run().catch((error: unknown) => {
	process.nextTick(() => {
		throw error;
	});
});

host.model.setResponses([
	fauxAssistantMessage("Owner failure baseline remains mounted."),
]);
await ownerSession.prompt("Owner transcript before child UI failure.");
await ownerSession.waitForIdle();
const ownerEditorFactory = ownerSession.extensionRunner.createContext().ui.getEditorComponent();
ownerSession.extensionRunner.createContext().ui.setEditorText(OWNER_EDITOR_TEXT);

host.model.setResponses([
	failureKind === "run"
		? async () => {
			await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
			return fauxAssistantMessage("Deterministic PTY terminal Run failure.", {
				stopReason: "error",
				errorMessage: "deterministic PTY terminal Run failure",
			});
		}
		: fauxAssistantMessage("Failure PTY child is ready."),
]);
let markInitializationPaused!: () => void;
const initializationPaused = new Promise<void>((resolve) => {
	markInitializationPaused = resolve;
});
const nativeInteractiveInit = InteractiveMode.prototype.init;
let failNextProjectionInitialization = failureKind === "initialization";
if (failNextProjectionInitialization) {
	InteractiveMode.prototype.init = async function (...args) {
		await nativeInteractiveInit.apply(this, args);
		if (!failNextProjectionInitialization) return;
		failNextProjectionInitialization = false;
		markInitializationPaused();
		await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
		throw new Error("deterministic PTY child initialization failure");
	};
}
const spawning = executeCommittedTool(
	ownerSession,
	appendToolSource(ownerSession, "agent_spawn", `pty-${failureKind}-failure-child`, {
		request: "Remain live until the deterministic child UI failure.",
		label: "PTY Failure Worker",
	}),
);
if (failureKind === "initialization") await initializationPaused;
const spawn = failureKind === "initialization" ? undefined : await spawning;
const childAgentId = spawn ? detailString(spawn.details, "agentId") : undefined;
if (failureKind === "noninteractive") {
	await host.runtime.dispose();
	mode.stop();
	if (childSessionShutdowns !== 1) {
		throw new Error(`Expected one non-interactive child shutdown, received ${childSessionShutdowns}`);
	}
	process.stdout.write("\n__PTY_NONINTERACTIVE_DISPOSAL_COMPLETE__\n");
} else {
	await finishInteractiveFailure();
}

async function finishInteractiveFailure(): Promise<void> {
	process.stdout.write(`\n__PTY_AGENT_VIEW_FAILURE_SETUP__${JSON.stringify({
		failureKind,
		childAgentId,
		ownerEditorText: OWNER_EDITOR_TEXT,
	})}\n`);
	await openAgents(ownerSession);
	const settledSpawn = spawn ?? await spawning;
	if (
		failureKind === "initialization" &&
		(
			detailString(settledSpawn.details, "disposition") !== "created_unscheduled" ||
			detailString(settledSpawn.details, "failedStage") !== "run_start"
		)
	) throw new Error("Initialization failure did not settle as created_unscheduled/run_start");
	InteractiveMode.prototype.init = nativeInteractiveInit;

	if (host.runtime.session !== ownerSession) {
		throw new Error("Child UI failure changed the Owner runtime session");
	}
	if (ownerSession.extensionRunner.createContext().ui.getEditorText() !== OWNER_EDITOR_TEXT) {
		throw new Error("Child UI failure changed Owner editor text");
	}
	if (ownerSession.extensionRunner.createContext().ui.getEditorComponent() !== ownerEditorFactory) {
		throw new Error("Child UI failure changed Owner editor implementation");
	}
	if (failureKind === "input" || failureKind === "render") {
		const expectedDiagnostic = `Agent view failed: deterministic PTY child ${failureKind} failure`;
		if (host.services.diagnostics.filter(({ message }) => message === expectedDiagnostic).length !== 1) {
			throw new Error(`Expected one bounded Owner diagnostic: ${expectedDiagnostic}`);
		}
	}
	process.stdout.write(`\n__PTY_AGENT_VIEW_FAILURE_RESTORED__${failureKind}\n`);
	(mode as unknown as { renderer: { renderNow(force?: boolean): void } }).renderer.renderNow(true);

	await host.runtime.dispose();
	mode.stop();
}

async function openAgents(session: AgentSession): Promise<void> {
	const command = session.extensionRunner.getCommand("agents");
	if (!command) throw new Error("PTY /agents command is unavailable");
	await command.handler("", session.extensionRunner.createCommandContext());
}

type ToolSource = Readonly<{
	entryId: string;
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
}>;

function appendToolSource(
	session: AgentSession,
	toolName: string,
	toolCallId: string,
	input: Record<string, unknown>,
): ToolSource {
	session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall(toolName, input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const entry = session.sessionManager.getLeafEntry();
	if (!entry) throw new Error(`PTY ${toolName} source did not commit`);
	return { entryId: entry.id, toolCallId, toolName, input };
}

async function executeCommittedTool(session: AgentSession, source: ToolSource) {
	const tool = session.getToolDefinition(source.toolName);
	if (!tool) throw new Error(`PTY tool ${source.toolName} is unavailable`);
	const result = await tool.execute(
		source.toolCallId,
		source.input as never,
		undefined,
		undefined,
		session.extensionRunner.createContext(),
	);
	session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: source.toolCallId,
		toolName: source.toolName,
		content: result.content,
		details: result.details,
		isError: false,
		timestamp: Date.now(),
	});
	return result;
}

function detailString(details: unknown, key: string): string {
	if (
		typeof details !== "object" ||
		details === null ||
		typeof (details as Record<string, unknown>)[key] !== "string"
	) throw new Error(`PTY receipt is missing ${key}`);
	return (details as Record<string, string>)[key]!;
}
