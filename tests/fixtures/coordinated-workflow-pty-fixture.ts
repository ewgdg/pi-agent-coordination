import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import {
	InteractiveMode,
	SessionManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";

import piAgentCoordination from "../../src/index.ts";
import { createUnboundTestOwnerHost } from "../support/pi-host.ts";

const OWNER_EDITOR_TEXT = "unfinished Owner editor text";
const DIRECT_AGENT_INPUT = "direct input through child editor";
const MAX_WAIT_ATTEMPTS = 2_000;
const LONG_CHILD_RESPONSE = [
	"Viewed child is ready for direct editor input.",
	...Array.from(
		{ length: 60 },
		(_value, index) => `Viewed child transcript line ${String(index).padStart(2, "0")}`,
	),
].join("\n");
const STREAMING_CHILD_RESPONSE = [
	"Viewed child handled direct editor input.",
	...Array.from(
		{ length: 40 },
		(_value, index) => `Streaming child update ${String(index).padStart(2, "0")}`,
	),
].join("\n");

const requestedColumns = Number(process.env.PTY_TEST_COLUMNS);
const requestedRows = Number(process.env.PTY_TEST_ROWS);
if (
	Number.isInteger(requestedColumns) && requestedColumns > 0 &&
	Number.isInteger(requestedRows) && requestedRows > 0
) {
	const resized = spawnSync(
		"stty",
		["cols", String(requestedColumns), "rows", String(requestedRows)],
		{ stdio: "inherit" },
	);
	if (resized.status !== 0) throw new Error("PTY fixture could not resize its terminal");
}

const host = await createUnboundTestOwnerHost(piAgentCoordination, {
	persistent: true,
	fauxTokensPerSecond: 400,
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
	fauxAssistantMessage("Owner baseline response remains mounted behind the Agent view."),
]);
await ownerSession.prompt("Owner baseline transcript before opening /agents.");
await ownerSession.waitForIdle();

host.model.setResponses([
	fauxAssistantMessage(LONG_CHILD_RESPONSE),
]);
const spawn = await executeCommittedTool(
	ownerSession,
	appendToolSource(ownerSession, "agent_spawn", "pty-spawn-viewed-agent", {
		request: "Remain active while the Owner inspects this Agent view.",
		label: "PTY Viewed Worker",
	}),
);
const childAgentId = detailString(spawn.details, "agentId");
const childTranscriptPath = await transcriptPathFor(childAgentId);
await waitFor(() =>
	JSON.stringify(SessionManager.open(childTranscriptPath).getEntries()).includes(
		"Viewed child is ready for direct editor input.",
	)
);
host.model.setResponses([
	fauxAssistantMessage("Second PTY child remains independently interactive."),
]);
const secondSpawn = await executeCommittedTool(
	ownerSession,
	appendToolSource(ownerSession, "agent_spawn", "pty-spawn-second-viewed-agent", {
		request: "Remain available as the second Agent-to-Agent switch target.",
		label: "PTY Second Worker",
	}),
);
const secondChildAgentId = detailString(secondSpawn.details, "agentId");
const secondChildTranscriptPath = await transcriptPathFor(secondChildAgentId);
await waitFor(() =>
	JSON.stringify(SessionManager.open(secondChildTranscriptPath).getEntries()).includes(
		"Second PTY child remains independently interactive.",
	)
);
host.model.setResponses([
	fauxAssistantMessage(STREAMING_CHILD_RESPONSE),
]);
const ownerEntryIds = ownerSession.sessionManager.getEntries().map(({ id }) => id);
const ownerEditorFactory = ownerSession.extensionRunner.createContext().ui.getEditorComponent();
ownerSession.extensionRunner.createContext().ui.setEditorText(OWNER_EDITOR_TEXT);
const ownerEditor = (mode as unknown as {
	editor: {
		getCursor(): Readonly<{ line: number; col: number }>;
		handleInput(data: string): void;
	};
}).editor;
for (let offset = 0; offset < 7; offset += 1) ownerEditor.handleInput("\x1b[D");
const ownerEditorCursor = ownerEditor.getCursor();

process.stdout.write(`\n__PTY_AGENT_VIEW_SETUP__${JSON.stringify({
	ownerId: ownerSession.sessionId,
	childAgentId,
	secondChildAgentId,
	cwd: host.cwd,
	ownerEditorText: OWNER_EDITOR_TEXT,
	ownerEditorCursor,
	terminalColumns: process.stdout.columns,
	terminalRows: process.stdout.rows,
})}\n`);
void (async () => {
	await waitFor(() =>
		JSON.stringify(SessionManager.open(childTranscriptPath).getEntries()).includes(
			"Streaming child update 39",
		)
	);
	await new Promise<void>((resolve) => setTimeout(resolve, 50));
	process.stdout.write("\n__PTY_CHILD_INPUT_SETTLED__\n");
})();
await openAgents(ownerSession);

if (host.runtime.session !== ownerSession) {
	throw new Error(`Agent view rebound runtime to ${host.runtime.session.sessionId}`);
}
if (ownerSession.extensionRunner.createContext().ui.getEditorText() !== OWNER_EDITOR_TEXT) {
	throw new Error("Agent view changed Owner editor text");
}
if (ownerSession.extensionRunner.createContext().ui.getEditorComponent() !== ownerEditorFactory) {
	throw new Error("Agent view changed Owner editor implementation");
}
if (
	JSON.stringify(ownerEditor.getCursor()) !==
	JSON.stringify(ownerEditorCursor)
) {
	throw new Error("Agent view changed Owner editor cursor");
}
if (
	JSON.stringify(ownerSession.sessionManager.getEntries().map(({ id }) => id)) !==
	JSON.stringify(ownerEntryIds)
) {
	throw new Error("Agent view changed Owner transcript entries");
}
if (
	JSON.stringify(SessionManager.open(childTranscriptPath).getEntries())
		.includes(DIRECT_AGENT_INPUT) === false
) {
	throw new Error("Interactive Agent view did not commit direct child input");
}
if (
	JSON.stringify(SessionManager.open(childTranscriptPath).getEntries())
		.includes("Streaming child update 39") === false
) {
	throw new Error("Interactive Agent view did not complete direct child input");
}
process.stdout.write("\n__PTY_AGENT_VIEW_CLOSED__\n");
(mode as unknown as {
	renderer: { renderNow(force?: boolean): void };
}).renderer.renderNow(true);

await host.runtime.dispose();
mode.stop();

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

async function transcriptPathFor(agentId: string): Promise<string> {
	const observe = ownerSession.getToolDefinition("agent_observe");
	if (!observe) throw new Error("PTY agent_observe tool is unavailable");
	const status = await observe.execute(
		"pty-locate-viewed-agent-transcript",
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

function detailString(details: unknown, key: string): string {
	if (
		typeof details !== "object" ||
		details === null ||
		typeof (details as Record<string, unknown>)[key] !== "string"
	) throw new Error(`PTY receipt is missing ${key}`);
	return (details as Record<string, string>)[key]!;
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < MAX_WAIT_ATTEMPTS; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("PTY fixture condition did not become true");
}
