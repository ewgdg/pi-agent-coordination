import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
	InteractiveMode,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import piAgentCoordination from "../../src/index.ts";
import { createUnboundTestOwnerHost } from "../support/pi-host.ts";

const OWNER_EDITOR_TEXT = "Owner input survives child UI failure";
const FAILURE_EXTENSION = fileURLToPath(
	new URL("./process-agent-view-failure-extension.ts", import.meta.url),
);
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

const evidencePath = join(tmpdir(), `.pty-agent-view-failure-${process.pid}.jsonl`);
const initializationReleasePath = join(
	tmpdir(),
	`.pty-agent-view-failure-${process.pid}.release`,
);
process.env.PTY_AGENT_VIEW_FAILURE_EVIDENCE = evidencePath;
process.env.PTY_AGENT_VIEW_FAILURE_RELEASE = initializationReleasePath;
const host = await createUnboundTestOwnerHost(piAgentCoordination, {
	persistent: true,
	additionalExtensionPaths: [FAILURE_EXTENSION],
});
const ownerSession = host.session;
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
	fauxAssistantMessage("Failure PTY child is ready."),
]);
const spawning = executeCommittedTool(
	ownerSession,
	appendToolSource(ownerSession, "agent_spawn", `pty-${failureKind}-failure-child`, {
		request: "Remain live until the deterministic child UI failure.",
		label: "PTY Failure Worker",
	}),
);
if (failureKind === "initialization") {
	await waitForEvidence((entries) => entries.some(({ kind }) => kind === "initialization_paused"));
}
const spawn = failureKind === "initialization" ? undefined : await spawning;
const childAgentId = spawn ? detailString(spawn.details, "agentId") : undefined;
if (failureKind === "run") {
	const transcriptPath = await transcriptPathFor(childAgentId as string);
	await waitForEvidenceCondition(() =>
		readFileText(transcriptPath).includes("Failure PTY child is ready.")
	);
	host.model.setResponses([
		fauxAssistantMessage("Deterministic PTY terminal Run failure.", {
			stopReason: "error",
			errorMessage: "deterministic PTY terminal Run failure",
		}),
	]);
	void (async () => {
		await waitForEvidenceCondition(
			() => readFileText(transcriptPath).includes("trigger selected Run failure"),
			20_000,
		);
		await waitForEvidenceCondition(
			() => readFileText(transcriptPath).includes("Deterministic PTY terminal Run failure"),
		);
		process.stdout.write("\n__PTY_SELECTED_RUN_FAILED__\n");
	})();
}
if (failureKind === "noninteractive") {
	await host.runtime.dispose();
	mode.stop();
	const childShutdowns = (await readEvidence()).filter(({ kind }) => kind === "session_shutdown");
	if (childShutdowns.length !== 1) {
		throw new Error(`Expected one non-interactive child shutdown, received ${childShutdowns.length}`);
	}
	process.stdout.write("\n__PTY_NONINTERACTIVE_DISPOSAL_COMPLETE__\n");
} else {
	await finishInteractiveFailure();
}

async function finishInteractiveFailure(): Promise<void> {
	process.stdout.write(`\n__PTY_AGENT_VIEW_FAILURE_SETUP__${JSON.stringify({
		failureKind,
		childAgentId,
		initializationReleasePath,
		ownerEditorText: OWNER_EDITOR_TEXT,
	})}\n`);
	await openAgents(ownerSession);
	const settledSpawn = spawn ?? await spawning;
	if (
		failureKind === "initialization" &&
		detailString(settledSpawn.details, "disposition") !== "pending"
	) throw new Error(`Process initialization failure was not admitted before the native TUI failed: ${JSON.stringify(settledSpawn.details)}`);
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
		const exactTriggers = (await readEvidence()).filter(
			(entry) => entry.kind === "failure_trigger" && entry.failureKind === failureKind,
		);
		if (exactTriggers.length !== 1) {
			throw new Error(`Expected one exact child ${failureKind} trigger, received ${exactTriggers.length}`);
		}
		const boundedDiagnostics = host.services.diagnostics.filter(
			({ message }) => message.startsWith("Agent view failed: child_runtime_unexpected_exit:"),
		);
		if (boundedDiagnostics.length !== 1) {
			throw new Error(`Expected one bounded Owner process-exit diagnostic; received ${JSON.stringify(host.services.diagnostics)}`);
		}
	}
	process.stdout.write(`\n__PTY_AGENT_VIEW_FAILURE_RESTORED__${failureKind}\n`);
	(mode as unknown as { renderer: { renderNow(force?: boolean): void } }).renderer.renderNow(true);
	await new Promise<void>((resolve) => setImmediate(resolve));

	await host.runtime.dispose();
	mode.stop();
}

async function openAgents(session: AgentSession): Promise<void> {
	const command = session.extensionRunner.getCommand("agents");
	if (!command) throw new Error("PTY /agents command is unavailable");
	await command.handler("", session.extensionRunner.createCommandContext());
}

async function transcriptPathFor(agentId: string): Promise<string> {
	const observe = ownerSession.getToolDefinition("agent_observe");
	if (!observe) throw new Error("PTY agent_observe is unavailable");
	const status = await observe.execute(
		`observe-${agentId}`,
		{ operation: "status", agentId },
		undefined,
		undefined,
		ownerSession.extensionRunner.createContext(),
	);
	const transcriptPath = (status.details as {
		primaryEvidence: { transcriptPath: string | null };
	}).primaryEvidence.transcriptPath;
	if (!transcriptPath) throw new Error(`PTY Agent ${agentId} has no transcript path`);
	return transcriptPath;
}

function readFileText(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}

async function waitForEvidenceCondition(
	predicate: () => boolean,
	timeoutMs = 10_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Child process transcript evidence did not become durable");
}

async function readEvidence(): Promise<Array<Record<string, unknown>>> {
	try {
		return (await readFile(evidencePath, "utf8"))
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

async function waitForEvidence(
	predicate: (entries: readonly Record<string, unknown>[]) => boolean,
): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (predicate(await readEvidence())) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Child process failure evidence did not become durable");
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
