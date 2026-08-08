import {
	fauxAssistantMessage,
	fauxToolCall,
	type Context,
} from "@earendil-works/pi-ai";
import {
	InteractiveMode,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";

import piAgentCoordination from "../../src/index.ts";
import { createUnboundTestOwnerHost } from "../support/pi-host.ts";

const ROUTED_MODEL_REQUEST_CAPACITY = 16;

const host = await createUnboundTestOwnerHost(piAgentCoordination, {
	persistent: true,
	implicitModeratorResponses: false,
	settings: { retry: { enabled: false } },
});
const ownerId = host.session.sessionId;
const mode = new InteractiveMode(host.runtime, { verbose: false });
await mode.init();
void mode.run().catch((error: unknown) => {
	process.nextTick(() => {
		throw error;
	});
});

let releaseChildGeneration!: () => void;
const childGenerationGate = new Promise<void>((resolve) => {
	releaseChildGeneration = resolve;
});
let markChildGenerationStarted!: () => void;
const childGenerationStarted = new Promise<void>((resolve) => {
	markChildGenerationStarted = resolve;
});

const routeInitialWorkflow = async (context: Context) => {
	const transcript = JSON.stringify(context.messages);
	if (transcript.includes("Stay live for the child-view overlay.")) {
		markChildGenerationStarted();
		await childGenerationGate;
		return fauxAssistantMessage("The child stays live for the overlay.");
	}
	throw new Error(`Unexpected initial PTY model context: ${context}`);
};
// One shared faux provider serves concurrent sessions, so route by transcript instead of request order.
host.model.setResponses(Array.from(
	{ length: ROUTED_MODEL_REQUEST_CAPACITY },
	() => routeInitialWorkflow,
));

const spawn = appendToolSource(host.session, "agent_spawn", "cv-pty-spawn", {
	request: "Stay live for the child-view overlay.",
	label: "Overlay Worker",
});
const spawnReceipt = await executeCommittedTool(host.session, spawn);
const childAgentId = detailString(spawnReceipt.details, "agentId");
await childGenerationStarted;

process.stdout.write(`\n__CV_SETUP__${JSON.stringify({
	ownerId,
	childAgentId,
	cwd: host.cwd,
})}\n`);
await openAgents(host.session);
host.session.extensionRunner.createContext().ui.setStatus("pty-peer-status", "Native Peer");
// Tab + Enter selects the live child through the native swap path.
await waitFor(() => host.runtime.session.sessionId === childAgentId);
process.stdout.write("\n__CV_SELECTED__\n");
// Let the selector surface close and the rebound editor settle before the
// overlay opens; then open it through the command handler (typing slash
// commands through the PTY races the autocomplete popup and is flaky).
await new Promise<void>((resolve) => setTimeout(resolve, 500));
const childViewCommand = host.runtime.session.extensionRunner.getCommand("child-view");
if (!childViewCommand) throw new Error("PTY child-view command is unavailable");
await childViewCommand.handler("", host.runtime.session.extensionRunner.createCommandContext());
// Keep the fixture alive for the interactive test.
await new Promise<void>(() => undefined);

function extractText(
	content: string | readonly { type: string; text?: string }[],
): string {
	return typeof content === "string"
		? content
		: content.map((part) => part.text ?? "").join("");
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
	if (!entry) throw new Error(`PTY tool source ${toolCallId} has no leaf entry`);
	return {
		entryId: entry.id,
		toolCallId,
		toolName,
		input,
	};
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
	return result as { details: Record<string, unknown> };
}

function detailString(details: unknown, key: string): string {
	if (
		typeof details !== "object" ||
		details === null ||
		typeof (details as Record<string, unknown>)[key] !== "string"
	) throw new Error(`PTY receipt is missing ${key}`);
	return (details as Record<string, string>)[key]!;
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 2_000; attempt += 1) {
		if (await predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("PTY workflow condition did not become true");
}
