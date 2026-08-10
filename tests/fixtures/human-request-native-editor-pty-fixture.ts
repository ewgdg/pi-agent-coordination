import {
	InteractiveMode,
	type ExtensionFactory,
	type MessageEndEvent,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

import {
	createAgentActivityExtension,
	createAgentBoundExtension,
} from "../../src/bootstrap/agent-extension.ts";
import type { OrdinaryAgentCoordinatorView } from "../../src/coordination/workflow-coordinator.ts";
import type { HumanAnswerCandidate } from "../../src/protocol/human-request.ts";
import { createUnboundTestOwnerHost } from "../support/pi-host.ts";

const QUESTION =
	"Which transcript-native boundary should remain authoritative when this deliberately long Human Request wraps across several terminal lines?";
const REQUEST_ID = "pty-human-request";
let pending = false;
let submittedAnswer: string | undefined;
let resolveAnswer!: (answer: HumanAnswerCandidate) => void;
const answerPromise = new Promise<HumanAnswerCandidate>((resolve) => {
	resolveAnswer = resolve;
});
const activityHandlers = new Set<() => void>();

const status = () => ({
	agentId: "pty-agent",
	workflowId: "pty-owner",
	label: "Requester",
	directSpawnerAgentId: "pty-owner",
	primaryEvidence: {
		transcriptPath: null,
		inspectedThrough: { agentId: "pty-agent", entryId: "pty-tail" },
	},
	run: {
		phase: "live" as const,
		work: "active" as const,
		attention: pending ? "input_required" as const : "none" as const,
		retentionReasons: [],
	},
});

const view = {
	status,
	agentActivity: () => ({
		scope: {
			...status(),
			model: { provider: "test", modelId: "test" },
			thinking: "off" as const,
			queuedInputCount: 0,
			failed: false,
		},
		children: [],
		answerMode: pending,
		humanAttention: [],
		operationalAttention: [],
	}),
	addAgentActivityChangeHandler(handler: () => void) {
		activityHandlers.add(handler);
		return () => activityHandlers.delete(handler);
	},
	refreshAgentActivity() {
		for (const handler of activityHandlers) handler();
	},
	async resumeFromHuman(text: string, images: readonly unknown[] | undefined) {
		if (!pending) return false;
		if ((images?.length ?? 0) > 0) throw new Error("Images are unsupported");
		if (text.trim().length === 0) throw new Error("Answer must not be blank");
		submittedAnswer = text;
		resolveAnswer({ requestId: REQUEST_ID, answer: text });
		return true;
	},
	selectionRoster: () => ({ live: [], dormant: [] }),
	async openAgentView() { return undefined; },
	humanAttention: () => [],
	operationalAttention: () => [],
	children: () => [],
	async message() { throw new Error("unused"); },
	async control() { throw new Error("unused"); },
	async askHuman() {
		pending = true;
		for (const handler of activityHandlers) handler();
		return answerPromise;
	},
	guardHumanToolResult(message: MessageEndEvent["message"]) {
		if (
			message.role === "toolResult" &&
			message.toolName === "ask_user_question" &&
			!message.isError
		) {
			pending = false;
			for (const handler of activityHandlers) handler();
		}
		return undefined;
	},
	reconcileHumanToolResults() {},
	async reachSafeBoundary() {},
	async beginExecution() {},
	async ensureExecution() {},
	beginToolExecution() {},
	reconcileCommittedToolResults() {},
	endExecution() {},
	async spawn() { throw new Error("unused"); },
} as unknown as OrdinaryAgentCoordinatorView;

const extension: ExtensionFactory = (pi) => {
	createAgentActivityExtension(() => view)(pi);
	createAgentBoundExtension(() => view)(pi);
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setEditorText("native draft");
	});
};

const host = await createUnboundTestOwnerHost(extension);
host.model.setResponses([
	fauxAssistantMessage(
		fauxToolCall("ask_user_question", { question: QUESTION }, { id: "pty-ask-user" }),
		{ stopReason: "toolUse" },
	),
	fauxAssistantMessage("The native editor Answer committed."),
]);
const interactiveMode = new InteractiveMode(host.runtime, {
	verbose: false,
	tuiMode: "fullscreen",
});
await interactiveMode.init();
await host.session.prompt("Open the transcript-native Human Request.");
await host.session.waitForIdle();
interactiveMode.stop();
await host.runtime.dispose();
process.stdout.write(`\n__PTY_RESULT__${JSON.stringify({ answer: submittedAnswer })}\n`);
