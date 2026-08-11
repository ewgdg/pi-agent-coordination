import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	fauxAssistantMessage,
	fauxToolCall,
	type ImageContent,
} from "@earendil-works/pi-ai";
import {
	SessionManager,
	type AgentSession,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

import {
	createAgentBoundExtension,
	createModeratorBoundExtension,
} from "../src/bootstrap/agent-extension.ts";
import { WorkflowCoordinator } from "../src/coordination/workflow-coordinator.ts";
import {
	inspectCommittedHumanRequestResult,
	resolveCommittedHumanRequest,
} from "../src/protocol/human-request.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import {
	bindTestOwnerHost,
	createUnboundTestOwnerHost,
	type TestOwnerHostOptions,
} from "./support/pi-host.ts";

test("one native text Answer is the sole result and releases the sequential sibling barrier", async () => {
	const { host, coordinator, view, child } = await createHumanRequestChild();
	const input = { question: "Which boundary should remain authoritative?" };
	const toolCallId = "ask-native-answer";
	host.model.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("ask_user_question", input, { id: toolCallId }),
				fauxToolCall("agent_observe", { operation: "status" }, { id: "after-answer" }),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The committed Human Answer is authoritative."),
	]);

	const run = child.session.prompt("Ask the human for one decision.");
	await waitForInputRequired(view, child.agentId);
	const attention = view.humanAttention().find((item) => item.agentId === child.agentId);
	assert.ok(attention);
	assert.equal(attention.question, input.question);
	assert.equal(
		child.session.sessionManager.getEntries().some(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolCallId === "after-answer",
		),
		false,
	);

	await child.session.prompt("Keep the native Pi result.", {
		streamingBehavior: "steer",
	});
	await run;
	await child.session.waitForIdle();

	const entries = child.session.sessionManager.getEntries();
	const answerResult = entries.find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === toolCallId,
	);
	assert.ok(answerResult && answerResult.type === "message");
	assert.equal(answerResult.message.role, "toolResult");
	assert.equal(answerResult.message.isError, false);
	assert.deepEqual(answerResult.message.details, {
		requestId: attention.requestId,
		answer: "Keep the native Pi result.",
	});
	assert.deepEqual(
		entries
			.filter(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					[toolCallId, "after-answer"].includes(entry.message.toolCallId),
			)
			.map((entry) =>
				entry.type === "message" && entry.message.role === "toolResult"
					? entry.message.toolCallId
					: undefined
			),
		[toolCallId, "after-answer"],
	);
	assert.equal(
		entries.some(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "user" &&
				JSON.stringify(entry.message.content).includes("Keep the native Pi result."),
		),
		false,
		"Answer adoption must not append an ordinary user Message",
	);
	assert.equal(
		entries.some((entry) => entry.type === "custom" && entry.customType.includes("human")),
		false,
	);
	assert.deepEqual(view.humanAttention(), []);

	await coordinator.shutdown(async () => host.runtime.dispose());
});

test("registered Human Request schema rejects blank and malformed questions before attention", async () => {
	const { host, coordinator, view, child } = await createHumanRequestChild();
	const toolCallIds = ["blank-human-question", "malformed-human-question"];
	host.model.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall(
					"ask_user_question",
					{ question: "   \n" },
					{ id: toolCallIds[0] },
				),
				fauxToolCall(
					"ask_user_question",
					{ prompt: "Missing required question" },
					{ id: toolCallIds[1] },
				),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Both unavailable requests were rejected."),
	]);
	await child.session.prompt("Attempt invalid Human Requests.");
	await child.session.waitForIdle();

	assert.notEqual(observedAttention(view, child.agentId), "input_required");
	assert.deepEqual(view.humanAttention(), []);
	const results = child.session.sessionManager.getEntries().filter(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			toolCallIds.includes(entry.message.toolCallId),
	);
	assert.equal(results.length, 2);
	assert.equal(results.every(
		(entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.isError,
	), true);

	await coordinator.shutdown(async () => host.runtime.dispose());
});

test("blank and image-bearing submissions do not resolve as Human Answers", async () => {
	const { host, coordinator, view, child } = await createHumanRequestChild();
	const toolCallId = "ask-for-validation";
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"ask_user_question",
				{ question: "Provide a text-only decision." },
				{ id: toolCallId },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The valid Answer was committed."),
	]);
	const run = child.session.prompt("Ask for validated input.");
	await waitForInputRequired(view, child.agentId);
	const childUi = child.session.extensionRunner.createContext().ui;

	await child.session.prompt("   ", { streamingBehavior: "steer" });
	assert.equal(childUi.getEditorText(), "   ");
	assert.equal(observedAttention(view, child.agentId), "input_required");
	const image: ImageContent = {
		type: "image",
		data: "aW1hZ2U=",
		mimeType: "image/png",
	};
	await child.session.prompt("Keep this text", {
		streamingBehavior: "steer",
		images: [image],
	});
	assert.equal(childUi.getEditorText(), "Keep this text");
	assert.equal(observedAttention(view, child.agentId), "input_required");
	assert.match(
		childUi.getEditorText(),
		/Keep this text/,
	);

	await child.session.prompt("Text-only Answer", { streamingBehavior: "steer" });
	await run;
	await child.session.waitForIdle();

	assert.equal(
		child.session.sessionManager.getEntries().filter(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolCallId === toolCallId &&
				!entry.message.isError,
		).length,
		1,
	);

	await coordinator.shutdown(async () => host.runtime.dispose());
});

test("Alt+Enter delivery and extension commands retain native behavior", async () => {
	let commandExecutions = 0;
	const { host, coordinator, view, child } = await createHumanRequestChild({
		additionalExtensionFactories: [{
			name: "answer-mode-command-probe",
			hidden: false,
			factory(pi) {
				pi.registerCommand("answer-mode-probe", {
					description: "Verify native command dispatch during Answer mode",
					async handler() {
						commandExecutions += 1;
					},
				});
			},
		}],
	});
	const toolCallId = "ask-before-follow-up";
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"ask_user_question",
				{ question: "Answer only after queuing later direction." },
				{ id: toolCallId },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The Answered turn settled."),
		fauxAssistantMessage("The queued follow-up ran later."),
	]);
	const run = child.session.prompt("Open the request.");
	await waitForInputRequired(view, child.agentId);
	const requestId = view.humanAttention().find(
		({ agentId }) => agentId === child.agentId,
	)?.requestId;
	assert.ok(requestId);
	await child.session.prompt("/answer-mode-probe", { streamingBehavior: "steer" });
	assert.equal(commandExecutions, 1);
	assert.equal(observedAttention(view, child.agentId), "input_required");

	await child.session.prompt("Queue this after the Answered turn.", {
		streamingBehavior: "followUp",
	});
	assert.equal(observedAttention(view, child.agentId), "input_required");
	assert.equal(
		child.session.sessionManager.getEntries().some(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolCallId === toolCallId,
		),
		false,
	);

	await child.session.prompt("Answer now", { streamingBehavior: "steer" });
	await run;
	await child.session.waitForIdle();
	const answer = child.session.sessionManager.getEntries().find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === toolCallId,
	);
	assert.ok(answer && answer.type === "message" && answer.message.role === "toolResult");
	assert.deepEqual(answer.message.details, {
		requestId,
		answer: "Answer now",
	});

	await coordinator.shutdown(async () => host.runtime.dispose());
});

test("an unrecognized slash-prefixed string is ordinary Answer text", async () => {
	const { host, coordinator, view, child } = await createHumanRequestChild();
	const toolCallId = "ask-for-slash-answer";
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall("ask_user_question", { question: "Give the slash Answer." }, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Slash Answer received."),
	]);
	const run = child.session.prompt("Ask for slash text.");
	await waitForInputRequired(view, child.agentId);
	await child.session.prompt("/not-a-command keep this literal", {
		streamingBehavior: "steer",
	});
	await run;
	await child.session.waitForIdle();
	const result = child.session.sessionManager.getEntries().find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === toolCallId,
	);
	assert.ok(result && result.type === "message" && result.message.role === "toolResult");
	assert.equal((result.message.details as { answer: string }).answer, "/not-a-command keep this literal");

	await coordinator.shutdown(async () => host.runtime.dispose());
});

test("primary Enter answers literally while Alt+Enter expands a prompt template", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "human-answer-prompt-"));
	const agentDir = join(cwd, ".pi-agent");
	await mkdir(join(agentDir, "prompts"), { recursive: true });
	await writeFile(
		join(agentDir, "prompts", "answer-template.md"),
		"---\ndescription: Queue a later prompt\n---\nExpanded follow-up: $@\n",
	);
	const { host, coordinator, view, child } = await createHumanRequestChild({
		cwd,
		agentDir,
		noPromptTemplates: false,
	});
	const toolCallId = "ask-for-literal-template-answer";
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"ask_user_question",
				{ question: "Submit a literal prompt-template command." },
				{ id: toolCallId },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The literal Answer committed."),
		fauxAssistantMessage("The expanded follow-up ran later."),
	]);
	const run = child.session.prompt("Ask for the literal command.");
	try {
		await waitForInputRequired(view, child.agentId);
		const requestId = view.humanAttention().find(
			({ agentId }) => agentId === child.agentId,
		)?.requestId;
		assert.ok(requestId);
		await child.session.prompt("/answer-template later work", {
			streamingBehavior: "followUp",
		});
		assert.equal(observedAttention(view, child.agentId), "input_required");

		await child.session.prompt("/answer-template", { streamingBehavior: "steer" });
		await waitForCondition(() => observedAttention(view, child.agentId) !== "input_required");
		await run;
		await child.session.waitForIdle();
		const result = child.session.sessionManager.getEntries().find(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolCallId === toolCallId,
		);
		assert.ok(result && result.type === "message" && result.message.role === "toolResult");
		assert.deepEqual(result.message.details, {
			requestId,
			answer: "/answer-template",
		});
		assert.equal(
			child.session.sessionManager.getEntries().some(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					(typeof entry.message.content === "string"
						? entry.message.content
						: textContent(entry.message.content)
					).includes("Expanded follow-up: later work"),
			),
			true,
		);
	} finally {
		if (observedAttention(view, child.agentId) === "input_required") {
			await child.session.abort();
			await run.catch(() => undefined);
		}
		await coordinator.shutdown(async () => host.runtime.dispose());
	}
});

test("different Agents wait and commit Human Answers independently", async () => {
	const { host, coordinator, view, child: first, spawnChild } =
		await createHumanRequestChild();
	const second = await spawnChild();
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"ask_user_question",
				{ question: "Answer the first Agent independently." },
				{ id: "first-independent-human-request" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(
			fauxToolCall(
				"ask_user_question",
				{ question: "Answer the second Agent independently." },
				{ id: "second-independent-human-request" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Second Agent received its Human Answer."),
		fauxAssistantMessage("First Agent received its Human Answer."),
	]);

	const firstRun = first.session.prompt("Open the first Human Request.");
	await waitForInputRequired(view, first.agentId);
	const secondRun = second.session.prompt("Open the second Human Request.");
	await waitForInputRequired(view, second.agentId);
	assert.deepEqual(
		view.humanAttention().map(({ agentId }) => agentId).sort(),
		[first.agentId, second.agentId].sort(),
	);
	const agentsCommand = host.session.prompt("/agents");
	await waitForCondition(() => host.ui.customSurfaces.length === 1);
	const selector = host.ui.customSurfaces[0]!;
	assert.match(selector.render(100).join("\n"), /DECIDE 1.*DECIDE 2/s);
	selector.handleInput?.("\x1b[B");
	selector.handleInput?.("\r");
	await waitForCondition(() => {
		if (host.ui.customSurfaces.length !== 1) return false;
		const frame = host.ui.customSurfaces[0]!.render(100).join("\n");
		return !frame.includes("Tab views") &&
			frame.includes("Answer the second Agent independently.");
	});
	const selectedAgentView = host.ui.customSurfaces[0]!;
	const selectedFrame = selectedAgentView.render(100).join("\n");
	assert.match(selectedFrame, /\[Ask User\]/);
	assert.match(selectedFrame, /Answer the second Agent independently\./);
	assert.match(selectedFrame, /ANSWER.*Enter submits/);

	selectedAgentView.handleInput?.("Second Answer");
	selectedAgentView.handleInput?.("\r");
	await secondRun;
	assert.equal(observedAttention(view, first.agentId), "input_required");
	assert.equal(
		view.humanAttention().some(({ agentId }) => agentId === first.agentId),
		true,
	);
	await first.session.prompt("First Answer", { streamingBehavior: "steer" });
	await firstRun;
	await Promise.all([first.session.waitForIdle(), second.session.waitForIdle()]);
	assert.deepEqual(view.humanAttention(), []);
	await view.openAgentView(view.status().agentId);
	await agentsCommand;

	await coordinator.shutdown(async () => host.runtime.dispose());
});

test("a precommit Run fence rejects and restores the provisional Answer", async () => {
	let ownerView: ReturnType<WorkflowCoordinator["forAgent"]> | undefined;
	let childUi: ExtensionUIContext | undefined;
	const childSessions = new Map<string, AgentSession>();
	const host = await createUnboundTestOwnerHost(
		createAgentBoundExtension(() => {
			if (!ownerView) throw new Error("Owner view unavailable");
			return ownerView;
		}),
		{ persistent: true },
	);
	const identity = adoptOrValidateOwnerIdentity(host.runtime, "<inline:pi-agent-coordination>");
	let coordinator!: WorkflowCoordinator;
	coordinator = new WorkflowCoordinator(host.runtime, identity, {
		entryModulePath: "<inline:pi-agent-coordination>",
		humanRequestBoundaryHooks: {
			beforeResultCommit: ({ failExactRun }) => {
				childUi?.setEditorText("newer draft");
				failExactRun();
			},
		},
		childExtensionFactory: (agentId) =>
			createAgentBoundExtension(() => coordinator.forAgent(agentId)),
		moderatorExtensionFactory: (agentId) =>
			createModeratorBoundExtension(() => coordinator.forModerator(agentId)),
		incidentBoundaryHooks: { beforeModeratorRunStart: () => "confirmed_failure" },
		spawnBoundaryHooks: {
			afterRunStart({ identity: childIdentity, session }) {
				childSessions.set(childIdentity.agentId, session);
			},
		},
	});
	ownerView = coordinator.forAgent(identity.agentId);
	await bindTestOwnerHost(host, "tui");
	const child = await spawnLiveChild(host, ownerView, childSessions);
	const toolCallId = "answer-before-fence";
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall("ask_user_question", { question: "Submit into the fence." }, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("This continuation must not run."),
	]);
	const run = child.session.prompt("Open the fenced request.");
	await waitForInputRequired(ownerView, child.agentId);
	childUi = child.session.extensionRunner.createContext().ui;
	await child.session.prompt("Restore this candidate", { streamingBehavior: "steer" });
	await run;
	await child.session.waitForIdle();
	await waitForCondition(() => ownerView.status(child.agentId).run.phase === "dormant");

	assert.equal(childUi.getEditorText(), "Restore this candidate\nnewer draft");
	assert.equal(ownerView.status(child.agentId).run.phase, "dormant");
	const result = child.session.sessionManager.getEntries().find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === toolCallId,
	);
	assert.ok(result && result.type === "message" && result.message.role === "toolResult");
	assert.equal(result.message.isError, true);
	assert.match(textContent(result.message.content), /Agent Run is no longer available/);
	assert.deepEqual(ownerView.humanAttention(), []);

	await coordinator.shutdown(async () => host.runtime.dispose());
});

test("a committed Answer remains canonical after later Run failure and reopened inspection", async () => {
	const { host, coordinator, view, child } = await createHumanRequestChild({ persistent: true });
	const input = { question: "Commit this Answer before later failure." };
	const toolCallId = "answer-before-later-failure";
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall("ask_user_question", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Fail only after commitment.", {
			stopReason: "error",
			errorMessage: "deterministic later failure",
		}),
	]);
	const run = child.session.prompt("Ask before failing.");
	await waitForInputRequired(view, child.agentId);
	await child.session.prompt("Canonical Answer", { streamingBehavior: "steer" });
	await run;
	await child.session.waitForIdle();

	const sessionFile = child.session.sessionManager.getSessionFile();
	assert.ok(sessionFile);
	const reopened = SessionManager.open(sessionFile);
	const request = resolveCommittedHumanRequest({
		agentId: child.agentId,
		transcript: transcriptFromSessionManager(reopened).inspect(),
		toolCallId,
		providedInput: input,
	});
	const resultEntry = reopened.getEntries().find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === toolCallId,
	);
	assert.ok(resultEntry);
	assert.deepEqual(
		inspectCommittedHumanRequestResult({
			request,
			transcript: transcriptFromSessionManager(reopened).inspect(),
		}),
		{
			state: "answered",
			answer: { requestId: request.requestId, answer: "Canonical Answer" },
			resultEntryId: resultEntry.id,
		},
	);

	await coordinator.shutdown(async () => host.runtime.dispose());
});

test("Human Request fails before input_required when no interactive Agent editor exists", async () => {
	let view: ReturnType<WorkflowCoordinator["forAgent"]> | undefined;
	const host = await createUnboundTestOwnerHost(
		(pi) => createAgentBoundExtension(() => {
			if (!view) throw new Error("View unavailable");
			return view;
		})(pi),
	);
	const identity = adoptOrValidateOwnerIdentity(host.runtime, "<inline:pi-agent-coordination>");
	let coordinator!: WorkflowCoordinator;
	coordinator = new WorkflowCoordinator(host.runtime, identity, {
		entryModulePath: "<inline:pi-agent-coordination>",
		childExtensionFactory: (agentId) =>
			createAgentBoundExtension(() => coordinator.forAgent(agentId)),
		moderatorExtensionFactory: (agentId) =>
			createModeratorBoundExtension(() => coordinator.forModerator(agentId)),
		incidentBoundaryHooks: { beforeModeratorRunStart: () => "confirmed_failure" },
	});
	view = coordinator.forAgent(identity.agentId);
	await bindTestOwnerHost(host, "tui");
	const toolCallId = "ask-without-projection";
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall("ask_user_question", { question: "This cannot be presented." }, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The unavailable request failed."),
	]);
	await host.session.prompt("Attempt an unavailable request.");
	await host.session.waitForIdle();
	assert.notEqual(observedAttention(view, identity.agentId), "input_required");
	assert.deepEqual(view.humanAttention(), []);
	const result = host.session.sessionManager.getEntries().find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === toolCallId,
	);
	assert.ok(result && result.type === "message" && result.message.role === "toolResult");
	assert.equal(result.message.isError, true);
	assert.match(textContent(result.message.content), /interactive Agent editor/);

	await coordinator.shutdown(async () => host.runtime.dispose());
});

async function createHumanRequestChild(options?: Pick<
	TestOwnerHostOptions,
	| "additionalExtensionFactories"
	| "persistent"
	| "cwd"
	| "agentDir"
	| "noPromptTemplates"
>) {
	let ownerView: ReturnType<WorkflowCoordinator["forAgent"]> | undefined;
	const childSessions = new Map<string, AgentSession>();
	const host = await createUnboundTestOwnerHost(
		createAgentBoundExtension(() => {
			if (!ownerView) throw new Error("Human Request owner view is unavailable");
			return ownerView;
		}),
		{ persistent: true, ...options },
	);
	const identity = adoptOrValidateOwnerIdentity(host.runtime, "<inline:pi-agent-coordination>");
	let coordinator!: WorkflowCoordinator;
	coordinator = new WorkflowCoordinator(host.runtime, identity, {
		entryModulePath: "<inline:pi-agent-coordination>",
		childExtensionFactory: (agentId) =>
			createAgentBoundExtension(() => coordinator.forAgent(agentId)),
		moderatorExtensionFactory: (agentId) =>
			createModeratorBoundExtension(() => coordinator.forModerator(agentId)),
		incidentBoundaryHooks: { beforeModeratorRunStart: () => "confirmed_failure" },
		spawnBoundaryHooks: {
			afterRunStart({ identity: childIdentity, session }) {
				childSessions.set(childIdentity.agentId, session);
			},
		},
	});
	const view = coordinator.forAgent(identity.agentId);
	ownerView = view;
	await bindTestOwnerHost(host, "tui");
	const child = await spawnLiveChild(host, view, childSessions);
	return {
		host,
		coordinator,
		view,
		child,
		spawnChild: () => spawnLiveChild(host, view, childSessions),
	};
}

async function spawnLiveChild(
	host: Awaited<ReturnType<typeof createUnboundTestOwnerHost>>,
	view: ReturnType<WorkflowCoordinator["forAgent"]>,
	childSessions: ReadonlyMap<string, AgentSession>,
): Promise<{ agentId: string; session: AgentSession }> {
	host.model.setResponses([
		fauxAssistantMessage("The Creation Request remains available for an Agent Answer."),
	]);
	const input = { request: "Open Human Requests when later instructed." };
	const toolCallId = `spawn-human-request-child-${childSessions.size}`;
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_spawn", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const receipt = await view.spawn(toolCallId, input);
	const agentId = "agentId" in receipt ? receipt.agentId : undefined;
	assert.ok(agentId);
	await waitForCondition(() => childSessions.has(agentId));
	const session = childSessions.get(agentId);
	assert.ok(session);
	await session.waitForIdle();
	return { agentId, session };
}

async function waitForInputRequired(
	view: ReturnType<WorkflowCoordinator["forAgent"]>,
	agentId: string,
): Promise<void> {
	await waitForCondition(() => observedAttention(view, agentId) === "input_required");
}

function observedAttention(
	view: ReturnType<WorkflowCoordinator["forAgent"]>,
	agentId: string,
): "none" | "input_required" | "dormant" {
	const run = view.status(agentId).run;
	return "attention" in run ? run.attention : "dormant";
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("Expected Human Request condition was not reached");
}

function textContent(content: readonly unknown[]): string {
	return content.flatMap((part) =>
		typeof part === "object" && part !== null &&
		"type" in part && part.type === "text" && "text" in part && typeof part.text === "string"
			? [part.text]
			: []
	).join("\n");
}
