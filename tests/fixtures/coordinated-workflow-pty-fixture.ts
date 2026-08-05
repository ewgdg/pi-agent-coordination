import {
	fauxAssistantMessage,
	fauxToolCall,
	type Context,
} from "@earendil-works/pi-ai";
import {
	InteractiveMode,
	SessionManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";

import piAgentCoordination from "../../src/index.ts";
import { deriveMessageIdentity } from "../../src/protocol/identities.ts";
import { createUnboundTestOwnerHost } from "../support/pi-host.ts";

const host = await createUnboundTestOwnerHost(piAgentCoordination, {
	persistent: true,
	implicitModeratorResponses: false,
});
const ownerId = host.session.sessionId;
const mode = new InteractiveMode(host.runtime, { verbose: false });
await mode.init();

let releaseLiveGeneration!: () => void;
const liveGenerationGate = new Promise<void>((resolve) => {
	releaseLiveGeneration = resolve;
});
let markLiveGenerationStarted!: () => void;
const liveGenerationStarted = new Promise<void>((resolve) => {
	markLiveGenerationStarted = resolve;
});
let releaseDormantGeneration!: () => void;
const dormantGenerationGate = new Promise<void>((resolve) => {
	releaseDormantGeneration = resolve;
});
let markDormantGenerationStarted!: () => void;
const dormantGenerationStarted = new Promise<void>((resolve) => {
	markDormantGenerationStarted = resolve;
});

const liveSpawn = appendToolSource(host.session, "agent_spawn", "pty-spawn-live", {
	request: "Stay active until selected, then answer this Creation Request.",
	label: "Worker Live",
});
const liveRequestId = deriveMessageIdentity({
	agentId: ownerId,
	entryId: liveSpawn.entryId,
	toolCallId: liveSpawn.toolCallId,
});
host.model.setResponses([
	async () => {
		markLiveGenerationStarted();
		await liveGenerationGate;
		return fauxAssistantMessage(
			fauxToolCall("agent_message", {
				operation: "answer",
				requestId: liveRequestId,
				answer: "The selected PTY child completed its Creation Request.",
			}, { id: "pty-answer-creation" }),
			{ stopReason: "toolUse" },
		);
	},
	async () => {
		markDormantGenerationStarted();
		await dormantGenerationGate;
		return fauxAssistantMessage("A terminated child must not commit this response.");
	},
	fauxAssistantMessage("The Owner received the child Creation Answer."),
	fauxAssistantMessage(
		fauxToolCall("ask_user_question", {
			questions: [{
				kind: "text",
				header: "Escape checkpoint",
				prompt: "Press Escape to establish a Hold.",
				multiline: false,
			}],
		}, { id: "pty-human-escape" }),
		{ stopReason: "toolUse" },
	),
	fauxAssistantMessage("The child remains held after Human Escape."),
]);
const liveReceipt = await executeCommittedTool(host.session, liveSpawn);
const liveAgentId = detailString(liveReceipt.details, "agentId");
await liveGenerationStarted;

const dormantSpawn = appendToolSource(host.session, "agent_spawn", "pty-spawn-dormant", {
	request: "Start, then become Dormant through explicit termination.",
	label: "Worker Dormant",
});
const dormantReceipt = await executeCommittedTool(host.session, dormantSpawn);
const dormantAgentId = detailString(dormantReceipt.details, "agentId");
await dormantGenerationStarted;
const terminateDormant = executeTool(host.session, "agent_control", "pty-terminate-dormant", {
	operation: "terminate",
	agentId: dormantAgentId,
});
releaseDormantGeneration();
await terminateDormant;

process.stdout.write(`\n__PTY_SETUP__${JSON.stringify({ ownerId, liveAgentId, dormantAgentId })}\n`);
await openAgents(host.session);
await waitFor(() => host.runtime.session.sessionId === liveAgentId);
const liveSession = host.runtime.session;
process.stdout.write("\n__PTY_SELECTED_LIVE__\n");
await liveSession.prompt("selected native input", { streamingBehavior: "steer" });
await waitFor(() =>
	liveSession.getSteeringMessages().some((message) =>
		JSON.stringify(message).includes("selected native input")
	) || liveSession.getFollowUpMessages().some((message) =>
		JSON.stringify(message).includes("selected native input")
	)
);
releaseLiveGeneration();
await waitFor(() => liveSession.sessionManager.getEntries().some(
	(entry) =>
		entry.type === "message" &&
		entry.message.role === "toolResult" &&
		entry.message.toolCallId === "pty-human-escape" &&
		entry.message.isError,
));
await liveSession.waitForIdle();
process.stdout.write("\n__PTY_HUMAN_ESCAPED__\n");

await openAgents(host.session);
await waitFor(() => host.runtime.session.sessionId === ownerId);
host.model.setResponses([
	fauxAssistantMessage("The held child resumed in one isolated turn."),
	fauxAssistantMessage("The child received the direct Message."),
	fauxAssistantMessage("The Owner received the child Request."),
	fauxAssistantMessage("The child received the correlated Answer."),
]);
await executeTool(host.session, "agent_control", "pty-resume-live", {
	operation: "resume",
	agentId: liveAgentId,
	content: "Resume after the Human Escape checkpoint.",
});
await liveSession.waitForIdle();
await executeTool(host.session, "agent_message", "pty-message-live", {
	operation: "send",
	targetAgentId: liveAgentId,
	content: "PTY direct Message round trip.",
});
await liveSession.waitForIdle();
const request = await executeTool(liveSession, "agent_message", "pty-request-owner", {
	operation: "request",
	targetAgentId: ownerId,
	question: "Did the native Request reach the Owner?",
});
await host.session.waitForIdle();
await executeTool(host.session, "agent_message", "pty-answer-live", {
	operation: "answer",
	requestId: detailString(request.details, "requestId"),
	answer: "Yes. The native Request and correlated Answer both committed.",
});
await liveSession.waitForIdle();
process.stdout.write("\n__PTY_ROUND_TRIPS__\n");

const routeAttentionFailure = (context: Context) =>
	context.tools?.some(({ name }) => name === "moderator_control")
		? fauxAssistantMessage("The PTY Moderator fails terminally.", {
			stopReason: "error",
			errorMessage: "deterministic PTY Moderator failure",
		})
		: fauxAssistantMessage("The Attention child settled with an unresolved obligation.");
host.model.setResponses(Array.from({ length: 16 }, () => routeAttentionFailure));
await executeTool(host.session, "agent_spawn", "pty-spawn-attention", {
	request: "Settle without answering so bounded Moderator failure reaches Owner Attention.",
	label: "Worker Attention",
});
await waitFor(async () => (await moderatorSessionCount()).valueOf() >= 2);
await new Promise<void>((resolve) => setImmediate(resolve));
await new Promise<void>((resolve) => setImmediate(resolve));
process.stdout.write("\n__PTY_ATTENTION_READY__\n");
await openAgents(host.session);
host.runtime.session.extensionRunner.shutdown();
await new Promise<void>(() => undefined);

async function moderatorSessionCount(): Promise<number> {
	const workflowDirectory = `${host.session.sessionManager.getSessionDir()}/pi-agent-coordination/${Buffer.from(
		ownerId,
		"utf8",
	).toString("base64url")}`;
	const sessions = await SessionManager.list(host.cwd, workflowDirectory);
	return sessions.filter(({ path }) => SessionManager.open(path).getEntries().some(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "agent-coordination.moderator-input",
	)).length;
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

function executeTool(
	session: AgentSession,
	toolName: string,
	toolCallId: string,
	input: Record<string, unknown>,
) {
	return executeCommittedTool(
		session,
		appendToolSource(session, toolName, toolCallId, input),
	);
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

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 2_000; attempt += 1) {
		if (await predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("PTY workflow condition did not become true");
}
