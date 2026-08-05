import assert from "node:assert/strict";
import test from "node:test";

import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	SessionManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";

import { createAgentBoundExtension } from "../src/bootstrap/agent-extension.ts";
import {
	WorkflowCoordinator,
} from "../src/coordination/workflow-coordinator.ts";
import { deriveHumanRequestIdentity } from "../src/protocol/identities.ts";
import {
	inspectCommittedHumanRequestResult,
	resolveCommittedHumanRequest,
} from "../src/protocol/human-request.ts";
import { HumanRequestSurface } from "../src/presentation/human-request-surface.ts";
import { adoptOrValidateOwnerIdentity } from "../src/protocol/owner-identity.ts";
import piAgentCoordination from "../src/index.ts";
import {
	bindTestOwnerHost,
	createTestOwnerHost,
	createUnboundTestOwnerHost,
} from "./support/pi-host.ts";

test("the native Human Request result is the sole positional Answer and sequential barrier", async () => {
	let view: ReturnType<WorkflowCoordinator["forAgent"]> | undefined;
	let resultPrecommit: { attention: string; matchingResults: number } | undefined;
	let laterToolStart: { attention: string; matchingResults: number } | undefined;
	const host = await createUnboundTestOwnerHost(
		(pi) => {
			createAgentBoundExtension(() => {
				if (!view) throw new Error("Human Request test view is unavailable");
				return view;
			})(pi);
			pi.on("message_end", (event) => {
				if (
					event.message.role !== "toolResult" ||
					event.message.toolName !== "ask_user_question"
				) return;
				const run = view!.status().run;
				resultPrecommit = {
					attention: "attention" in run ? run.attention : "dormant",
					matchingResults: host.session.sessionManager.getEntries().filter(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "toolResult" &&
							entry.message.toolCallId === "ask-mixed-human-request",
					).length,
				};
			});
			pi.registerTool({
				name: "after_human_answer",
				label: "After Human Answer",
				description: "Observe the native sequential Human Request barrier.",
				executionMode: "parallel",
				parameters: Type.Object({}, { additionalProperties: false }),
				async execute() {
					const run = view!.status().run;
					laterToolStart = {
						attention: "attention" in run ? run.attention : "dormant",
						matchingResults: host.session.sessionManager.getEntries().filter(
							(entry) =>
								entry.type === "message" &&
								entry.message.role === "toolResult" &&
								entry.message.toolCallId === "ask-mixed-human-request",
						).length,
					};
					return {
						content: [{ type: "text", text: "Later tool started." }],
						details: {},
					};
				},
			});
		},
	);
	const identity = adoptOrValidateOwnerIdentity(
		host.runtime,
		"<inline:pi-agent-coordination>",
	);
	const coordinator = new WorkflowCoordinator(host.runtime, identity, {
		entryModulePath: "<inline:pi-agent-coordination>",
		humanRequestPresentation: new HumanRequestSurface(host.ui),
		childExtensionFactory: (agentId) =>
			createAgentBoundExtension(() => coordinator.forAgent(agentId)),
	});
	view = coordinator.forAgent(identity.agentId);
	await bindTestOwnerHost(host, "tui");

	const tool = host.session.getToolDefinition("ask_user_question");
	assert.ok(tool);
	assert.equal(tool.executionMode, "sequential");
	const input = {
		questions: [
			{
				kind: "select_one",
				header: "Architecture",
				prompt: "Which implementation boundary should remain authoritative?",
				options: [
					{ label: "Native Pi", description: "Keep the native tool result authoritative." },
					{ label: "Protocol store" },
				],
				allowOther: false,
			},
			{
				kind: "select_many",
				header: "Validation",
				prompt: "Which public seams should be exercised?",
				options: [
					{ label: "Real session" },
					{ label: "PTY" },
					{ label: "Reopened transcript" },
				],
				allowOther: true,
			},
			{
				kind: "text",
				header: "Rationale",
				prompt: "Why must submission wait for transcript commitment?",
				multiline: true,
			},
		],
	} as const;
	const toolCallId = "ask-mixed-human-request";
	host.model.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("ask_user_question", input, { id: toolCallId }),
				fauxToolCall("after_human_answer", {}, { id: "later-sibling-call" }),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The committed Human Answer is now authoritative."),
	]);
	const prompt = host.session.prompt("Ask me for the complete structured decision.");
	await waitForCondition(() => {
		const run = view!.status().run;
		return "attention" in run && run.attention === "input_required";
	});
	await waitForCondition(() => host.ui.customSurfaces.length === 1);
	const sourceEntry = host.session.sessionManager.getEntries().find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.content.some(
				(part) => part.type === "toolCall" && part.id === toolCallId,
			),
	);
	assert.ok(sourceEntry);
	const requestId = deriveHumanRequestIdentity({
		agentId: identity.agentId,
		entryId: sourceEntry.id,
		toolCallId,
	});
	assert.deepEqual(view.humanAttention(), [
		{
			requestId,
			agentId: identity.agentId,
			agentLabel: "owner",
			questionCount: 3,
		},
	]);

	const expectedAnswers = [
		{ kind: "select_one", selectedOptionIndex: 0 },
		{
			kind: "select_many",
			selectedOptionIndexes: [0, 2],
		},
		{
			kind: "text",
			text: "Only the committed native result is protocol evidence.",
		},
	] as const;
	const surface = host.ui.customSurfaces[0];
	assert.ok(surface?.handleInput);
	surface.handleInput("\r");
	surface.handleInput(" ");
	surface.handleInput("\x1b[B");
	surface.handleInput("\x1b[B");
	surface.handleInput(" ");
	surface.handleInput("\r");
	surface.handleInput("Only the committed native result is protocol evidence.");
	surface.handleInput("\r");
	surface.handleInput("\r");
	await prompt;
	await host.session.waitForIdle();

	assert.deepEqual(resultPrecommit, {
		attention: "input_required",
		matchingResults: 0,
	});
	assert.deepEqual(laterToolStart, {
		attention: "none",
		matchingResults: 1,
	});
	const run = view.status().run;
	assert.equal("attention" in run ? run.attention : "dormant", "none");
	assert.deepEqual(view.humanAttention(), []);
	const entries = host.session.sessionManager.getEntries();
	assert.equal(
		entries.filter(
			(entry) =>
				entry.type === "custom" &&
				entry.customType.includes("human"),
		).length,
		0,
	);
	assert.equal(
		entries.filter(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolCallId === toolCallId &&
				!entry.message.isError,
		).length,
		1,
	);
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
		requestId,
		answers: expectedAnswers,
	});
	assert.deepEqual(
		entries
			.filter(
				(entry) => entry.type === "message" && entry.message.role === "toolResult",
			)
			.slice(-2)
			.map((entry) =>
				entry.type === "message" && entry.message.role === "toolResult"
					? entry.message.toolCallId
					: undefined
			),
		[toolCallId, "later-sibling-call"],
	);

	await coordinator.shutdown(async () => host.runtime.dispose());
});

test("an all-select request accepts allowed custom input and submits from its final tab", async () => {
	const host = await createTestOwnerHost(piAgentCoordination);
	const input = {
		questions: [
			{
				kind: "select_one",
				header: "Approach",
				prompt: "Which approach should we use?",
				options: [{ label: "Listed approach" }],
				allowOther: true,
			},
			{
				kind: "select_many",
				header: "Checks",
				prompt: "Which checks are required?",
				options: [
					{ label: "Real session" },
					{ label: "PTY" },
				],
				allowOther: false,
			},
		],
	} as const;
	const toolCallId = "ask-all-select-request";
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall("ask_user_question", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The custom selection was committed."),
	]);
	const prompt = host.session.prompt("Ask for the all-select decision.");
	let completed = false;
	try {
		await waitForCondition(() => host.ui.customSurfaces.length === 1);
		const surface = host.ui.customSurfaces[0];
		assert.ok(surface?.handleInput);
		const firstTab = surface.render(80).join("\n");
		assert.match(firstTab, /Approach/);
		assert.match(firstTab, /Checks/);
		assert.match(firstTab, /Other/);

		surface.handleInput("\x1b[B");
		surface.handleInput("\r");
		surface.handleInput("A smaller generic boundary");
		surface.handleInput("\r");
		surface.handleInput(" ");
		surface.handleInput("\r");
		await prompt;
		await host.session.waitForIdle();
		completed = true;

		const answerResult = host.session.sessionManager.getEntries().find(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolCallId === toolCallId,
		);
		assert.ok(answerResult && answerResult.type === "message");
		assert.equal(answerResult.message.role, "toolResult");
		assert.equal(answerResult.message.isError, false);
		assert.deepEqual(
			(answerResult.message.details as { answers: unknown[] }).answers,
			[
				{ kind: "select_one", customValue: "A smaller generic boundary" },
				{ kind: "select_many", selectedOptionIndexes: [0] },
			],
		);
	} finally {
		if (!completed) {
			host.ui.customSurfaces[0]?.handleInput?.("\x1b");
			await prompt.catch(() => undefined);
		}
		await host.runtime.dispose();
	}
});

test("the registered tool rejects malformed Questions before opening human attention", async () => {
	const host = await createTestOwnerHost(piAgentCoordination);
	const invalidCalls = [
		fauxToolCall(
			"ask_user_question",
			{ questions: [] },
			{ id: "ask-no-questions" },
		),
		fauxToolCall(
			"ask_user_question",
			{
				questions: [{
					kind: "text",
					header: "Header",
					prompt: "Prompt",
					multiline: false,
					unknown: true,
				}],
			},
			{ id: "ask-unknown-field" },
		),
		fauxToolCall(
			"ask_user_question",
			{
				questions: [{
					kind: "rating",
					header: "Header",
					prompt: "Prompt",
				}],
			},
			{ id: "ask-unknown-kind" },
		),
		fauxToolCall(
			"ask_user_question",
			{
				questions: [{
					kind: "select_one",
					header: "Header",
					prompt: "Prompt",
					options: [],
					allowOther: true,
				}],
			},
			{ id: "ask-no-options" },
		),
		fauxToolCall(
			"ask_user_question",
			{
				questions: [{
					kind: "text",
					header: "Header",
					prompt: "   ",
					multiline: false,
				}],
			},
			{ id: "ask-blank-prompt" },
		),
	];
	host.model.setResponses([
		fauxAssistantMessage(invalidCalls, { stopReason: "toolUse" }),
		fauxAssistantMessage("The malformed Questions were rejected."),
	]);
	await host.session.prompt("Try malformed Human Questions.");
	await host.session.waitForIdle();

	const invalidCallIds = invalidCalls.map(({ id }) => id);
	const results = host.session.sessionManager.getEntries().filter(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			invalidCallIds.includes(entry.message.toolCallId),
	);
	assert.deepEqual(
		results.map((entry) =>
			entry.type === "message" && entry.message.role === "toolResult"
				? [entry.message.toolCallId, entry.message.isError]
				: undefined
		),
		invalidCallIds.map((toolCallId) => [toolCallId, true]),
	);
	assert.equal(host.ui.customSurfaces.length, 0);

	await host.runtime.dispose();
});

test("two Agents wait independently while Steer follows Answer commit and Deferred follows settlement", async () => {
	let view: ReturnType<WorkflowCoordinator["forAgent"]> | undefined;
	const childSessions = new Map<string, AgentSession>();
	const host = await createUnboundTestOwnerHost(
		createAgentBoundExtension(() => {
			if (!view) throw new Error("Concurrent Human Request view is unavailable");
			return view;
		}),
		{ persistent: true },
	);
	const identity = adoptOrValidateOwnerIdentity(
		host.runtime,
		"<inline:pi-agent-coordination>",
	);
	const coordinator = new WorkflowCoordinator(host.runtime, identity, {
		entryModulePath: "<inline:pi-agent-coordination>",
		humanRequestPresentation: new HumanRequestSurface(host.ui),
		childExtensionFactory: (agentId) =>
			createAgentBoundExtension(() => coordinator.forAgent(agentId)),
		spawnBoundaryHooks: {
			afterRunStart({ identity: childIdentity, session }) {
				childSessions.set(childIdentity.agentId, session);
			},
		},
	});
	view = coordinator.forAgent(identity.agentId);
	await bindTestOwnerHost(host, "tui");

	const first = await spawnLiveChild(
		host,
		view,
		childSessions,
		"spawn-first-human-waiter",
		"Wait for the first Human Question.",
	);
	const second = await spawnLiveChild(
		host,
		view,
		childSessions,
		"spawn-second-human-waiter",
		"Wait for the second Human Question.",
	);
	const firstQuestionCallId = "first-child-human-question";
	const secondQuestionCallId = "second-child-human-question";
	const question = (header: string, prompt: string) => ({
		questions: [{ kind: "text" as const, header, prompt, multiline: false }],
	});
	const continuationObservations: Array<{
		answerIndex: number;
		deliveries: Array<{ index: number; content: string }>;
	}> = [];
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"ask_user_question",
				question("First", "Answer the first child."),
				{ id: firstQuestionCallId },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(
			fauxToolCall(
				"ask_user_question",
				question("Second", "Answer the second child."),
				{ id: secondQuestionCallId },
			),
			{ stopReason: "toolUse" },
		),
		(context) => {
			continuationObservations.push(
				observeContinuation(context.messages, firstQuestionCallId),
			);
			return fauxAssistantMessage("The first Human Answer and Steer were observed.");
		},
		(context) => {
			continuationObservations.push(
				observeContinuation(context.messages, firstQuestionCallId),
			);
			return fauxAssistantMessage("The Deferred Message followed settlement.");
		},
		fauxAssistantMessage("The second Human Answer was observed."),
	]);
	const firstRun = first.session.prompt("Ask the first Human Question.");
	await waitForInputRequired(view, first.agentId);
	const secondRun = second.session.prompt("Ask the second Human Question.");
	await waitForInputRequired(view, second.agentId);

	assert.equal(host.ui.customSurfaces.length, 0, "background Requests must not steal focus");
	assert.deepEqual(
		view.humanAttention().map(({ agentId }) => agentId).sort(),
		[first.agentId, second.agentId].sort(),
	);
	await host.session.prompt("/agents");
	const decideRows = host.ui.agentViews.at(-1)?.options.slice(0, 2);
	assert.deepEqual(decideRows, [
		"DECIDE 1 · agent · 1 Question",
		"DECIDE 2 · agent · 1 Question",
	]);

	await authorMessageToAgent(
		host,
		view,
		first.agentId,
		"steer-after-human-answer",
		"Steer only after the Human Answer commits.",
		"steer",
	);
	await authorMessageToAgent(
		host,
		view,
		first.agentId,
		"deferred-after-human-turn",
		"Deferred only after the answered turn settles.",
		"deferred",
	);
	assert.equal(observedAttention(view, second.agentId), "input_required");

	const firstAttention = view.humanAttention().find(
		(item) => item.agentId === first.agentId,
	);
	assert.ok(firstAttention);
	const firstFocus = view.focusHumanRequest(firstAttention.requestId);
	await waitForCondition(() => host.ui.customSurfaces.length === 1);
	host.ui.customSurfaces[0]!.handleInput?.("First positional Answer");
	host.ui.customSurfaces[0]!.handleInput?.("\r");
	await firstFocus;
	await firstRun;
	await waitForCondition(() => continuationObservations.length === 2);
	assert.equal(observedAttention(view, second.agentId), "input_required");
	assert.equal(
		view.humanAttention().some((item) => item.agentId === second.agentId),
		true,
	);

	assert.equal(continuationObservations[0]!.answerIndex >= 0, true);
	assert.deepEqual(
		continuationObservations[0]!.deliveries.map(({ content }) => content),
		["Steer only after the Human Answer commits."],
	);
	assert.equal(
		continuationObservations[0]!.answerIndex <
			continuationObservations[0]!.deliveries[0]!.index,
		true,
	);
	assert.deepEqual(
		continuationObservations[1]!.deliveries.map(({ content }) => content),
		[
			"Steer only after the Human Answer commits.",
			"Deferred only after the answered turn settles.",
		],
	);

	const secondAttention = view.humanAttention().find(
		(item) => item.agentId === second.agentId,
	);
	assert.ok(secondAttention);
	const secondFocus = view.focusHumanRequest(secondAttention.requestId);
	await waitForCondition(() => host.ui.customSurfaces.length === 1);
	host.ui.customSurfaces[0]!.handleInput?.("Second positional Answer");
	host.ui.customSurfaces[0]!.handleInput?.("\r");
	await secondFocus;
	await secondRun;
	await second.session.waitForIdle();
	assert.deepEqual(view.humanAttention(), []);

	await coordinator.shutdown(async () => host.runtime.dispose());
});

test("Escape settles one matching error result and does not run a later sibling call", async () => {
	const host = await createTestOwnerHost(piAgentCoordination);
	host.ui.setEditorText("preserve this occupied editor draft");
	const questionCallId = "ask-before-escape";
	const laterCallId = "observe-after-escape";
	host.model.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall(
					"ask_user_question",
					{
						questions: [{
							kind: "text",
							header: "Interrupt",
							prompt: "Press Escape instead of answering.",
							multiline: false,
						}],
					},
					{ id: questionCallId },
				),
				fauxToolCall(
					"agent_observe",
					{ operation: "status" },
					{ id: laterCallId },
				),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("This automatic continuation must not run."),
	]);
	const prompt = host.session.prompt("Open a Human Request that I will interrupt.");
	await waitForCondition(() => host.ui.customSurfaces.length === 1);
	host.ui.customSurfaces[0]!.handleInput?.("\x1b");
	await prompt;
	await host.session.waitForIdle();

	const results = host.session.sessionManager.getEntries().filter(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			(entry.message.toolCallId === questionCallId ||
				entry.message.toolCallId === laterCallId),
	);
	assert.equal(results.length, 1);
	const interrupted = results[0];
	assert.ok(interrupted && interrupted.type === "message");
	assert.equal(interrupted.message.role, "toolResult");
	assert.equal(interrupted.message.toolCallId, questionCallId);
	assert.equal(interrupted.message.isError, true);
	assert.match(
		interrupted.message.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map(({ text }) => text)
			.join("\n"),
		/interrupted before an answer/i,
	);
	assert.equal(host.ui.getEditorText(), "preserve this occupied editor draft");
	assert.equal(host.ui.customSurfaces.length, 0);
	assert.equal(
		host.session.sessionManager.getEntries().some(
			(entry) => entry.type === "custom" && entry.customType.includes("human"),
		),
		false,
	);
	const observe = host.session.getToolDefinition("agent_observe");
	assert.ok(observe);
	const heldStatus = await observe.execute(
		"observe-human-escape-hold",
		{ operation: "status" },
		undefined,
		undefined,
		host.session.extensionRunner.createContext(),
	);
	assert.equal(
		(heldStatus.details as {
			run: { retentionReasons: Array<{ reason: string }> };
		}).run.retentionReasons.some(({ reason }) => reason === "interruption_hold"),
		true,
	);

	await host.runtime.dispose();
});

test("a committed Human Answer remains canonical when the Run subsequently fails", async () => {
	const host = await createTestOwnerHost(piAgentCoordination, { persistent: true });
	const input = {
		questions: [{
			kind: "text" as const,
			header: "Race",
			prompt: "Commit this Answer before the Run failure.",
			multiline: false,
		}],
	};
	const toolCallId = "answer-before-run-failure";
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall("ask_user_question", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("The Run fails only after the Answer committed.", {
			stopReason: "error",
			errorMessage: "deterministic post-Answer Run failure",
		}),
	]);
	const prompt = host.session.prompt("Ask before this Run fails.");
	await waitForCondition(() => host.ui.customSurfaces.length === 1);
	host.ui.customSurfaces[0]!.handleInput?.("Canonical despite later failure");
	host.ui.customSurfaces[0]!.handleInput?.("\r");
	await prompt;
	await host.session.waitForIdle();

	const sourceEntry = host.session.sessionManager.getEntries().find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.content.some(
				(part) => part.type === "toolCall" && part.id === toolCallId,
			),
	);
	assert.ok(sourceEntry);
	const sessionFile = host.session.sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("Persistent Human Request test has no session file");
	const reopened = SessionManager.open(sessionFile);
	const request = resolveCommittedHumanRequest({
		agentId: host.session.sessionId,
		sessionManager: reopened,
		toolCallId,
		providedInput: input,
	});
	assert.deepEqual(
		inspectCommittedHumanRequestResult({ request, sessionManager: reopened }),
		{
			state: "answered",
			answer: {
				requestId: request.requestId,
				answers: [{ kind: "text", text: "Canonical despite later failure" }],
			},
			resultEntryId: reopened.getEntries().find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolCallId === toolCallId,
			)!.id,
		},
	);
	assert.equal(host.ui.customSurfaces.length, 0);

	await host.runtime.dispose();
});

test("a Run fence after submission but before result commitment prevents a Human Answer", async () => {
	let view: ReturnType<WorkflowCoordinator["forAgent"]> | undefined;
	let precommitFenceCount = 0;
	const host = await createUnboundTestOwnerHost(
		(pi) => createAgentBoundExtension(() => {
			if (!view) throw new Error("Submission-fence Human Request view is unavailable");
			return view;
		})(pi),
		{ persistent: true },
	);
	const identity = adoptOrValidateOwnerIdentity(
		host.runtime,
		"<inline:pi-agent-coordination>",
	);
	const coordinator = new WorkflowCoordinator(host.runtime, identity, {
		entryModulePath: "<inline:pi-agent-coordination>",
		humanRequestPresentation: new HumanRequestSurface(host.ui),
		humanRequestBoundaryHooks: {
			beforeResultCommit: ({ failExactRun }) => {
				precommitFenceCount += 1;
				failExactRun();
			},
		},
		childExtensionFactory: (agentId) =>
			createAgentBoundExtension(() => coordinator.forAgent(agentId)),
	});
	view = coordinator.forAgent(identity.agentId);
	await bindTestOwnerHost(host, "tui");
	const input = {
		questions: [{
			kind: "text" as const,
			header: "Commit race",
			prompt: "Submit before the exact Run fence.",
			multiline: false,
		}],
	};
	const toolCallId = "submission-before-result-fence";
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall("ask_user_question", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("This continuation must not establish a Human Answer."),
	]);
	const prompt = host.session.prompt("Open the exact result-commit race.");
	await waitForCondition(() => host.ui.customSurfaces.length === 1);
	host.ui.customSurfaces[0]!.handleInput?.("Candidate only");
	host.ui.customSurfaces[0]!.handleInput?.("\r");
	await prompt;
	await host.session.waitForIdle();
	await waitForCondition(() => view!.status(identity.agentId).run.phase === "dormant");

	const sourceEntry = host.session.sessionManager.getEntries().find(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.content.some(
				(part) => part.type === "toolCall" && part.id === toolCallId,
			),
	);
	assert.ok(sourceEntry);
	const sessionFile = host.session.sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("Submission-fence test has no transcript");
	const reopened = SessionManager.open(sessionFile);
	assert.equal(precommitFenceCount, 1);
	assert.deepEqual(host.ui.notifications, []);
	const request = resolveCommittedHumanRequest({
		agentId: identity.agentId,
		sessionManager: reopened,
		toolCallId,
		providedInput: input,
	});
	assert.equal(
		inspectCommittedHumanRequestResult({ request, sessionManager: reopened }).state,
		"interrupted",
	);
	assert.equal(observedAttention(view, identity.agentId), "dormant");
	assert.deepEqual(view.humanAttention(), []);
	assert.equal(
		reopened.getEntries().some(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some(
					(part) => part.type === "text" &&
						part.text === "This continuation must not establish a Human Answer.",
				),
		),
		false,
	);

	await coordinator.shutdown(async () => host.runtime.dispose());
});

test("a failed-Run fence closes the UI, rejects late submission, and is not reconstructed", async () => {
	let view: ReturnType<WorkflowCoordinator["forAgent"]> | undefined;
	const childSessions = new Map<string, AgentSession>();
	const fenceExactRuns = new Map<string, () => Promise<void>>();
	const host = await createUnboundTestOwnerHost(
		createAgentBoundExtension(() => {
			if (!view) throw new Error("Failed-Run Human Request view is unavailable");
			return view;
		}),
		{ persistent: true },
	);
	const identity = adoptOrValidateOwnerIdentity(
		host.runtime,
		"<inline:pi-agent-coordination>",
	);
	const coordinator = new WorkflowCoordinator(host.runtime, identity, {
		entryModulePath: "<inline:pi-agent-coordination>",
		humanRequestPresentation: new HumanRequestSurface(host.ui),
		humanRequestBoundaryHooks: {
			afterAdmission({ agentId, fenceExactRun }) {
				fenceExactRuns.set(agentId, fenceExactRun);
			},
		},
		childExtensionFactory: (agentId) =>
			createAgentBoundExtension(() => coordinator.forAgent(agentId)),
		spawnBoundaryHooks: {
			afterRunStart({ identity: childIdentity, session }) {
				childSessions.set(childIdentity.agentId, session);
			},
		},
	});
	view = coordinator.forAgent(identity.agentId);
	await bindTestOwnerHost(host, "tui");
	const child = await spawnLiveChild(
		host,
		view,
		childSessions,
		"spawn-failed-human-waiter",
		"Wait for a Human Request that loses its Run race.",
	);
	const input = {
		questions: [{
			kind: "text" as const,
			header: "Failure race",
			prompt: "This exact Run will fail before submission.",
			multiline: false,
		}],
	};
	const toolCallId = "human-request-before-run-fence";
	host.model.setResponses([
		fauxAssistantMessage(
			fauxToolCall("ask_user_question", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("No continuation should reconstruct this Human Request."),
	]);
	const failedRun = child.session.prompt("Open the Human Request before failure.");
	await waitForInputRequired(view, child.agentId);
	const attention = view.humanAttention().find((item) => item.agentId === child.agentId);
	assert.ok(attention);
	const focused = view.focusHumanRequest(attention.requestId);
	await waitForCondition(() => host.ui.customSurfaces.length === 1);
	const staleSurface = host.ui.customSurfaces[0]!;

	// A live in-process tool cannot spontaneously lose its containing Run under the
	// deterministic provider, so this exact host fence is the agreed race boundary.
	const fenceExactRun = fenceExactRuns.get(child.agentId);
	if (!fenceExactRun) throw new Error("Human Request Run fence was not captured");
	await fenceExactRun();
	await failedRun;
	await focused;
	assert.equal(view.status(child.agentId).run.phase, "dormant");
	assert.equal(host.ui.customSurfaces.length, 0);
	assert.equal(
		view.humanAttention().some((item) => item.requestId === attention.requestId),
		false,
	);
	staleSurface.handleInput?.("Too late");
	staleSurface.handleInput?.("\r");

	const sessionFile = child.session.sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("Failed-Run child has no persistent transcript");
	let reopened = SessionManager.open(sessionFile);
	const request = resolveCommittedHumanRequest({
		agentId: child.agentId,
		sessionManager: reopened,
		toolCallId,
		providedInput: input,
	});
	assert.equal(
		inspectCommittedHumanRequestResult({ request, sessionManager: reopened }).state,
		"interrupted",
	);
	assert.equal(
		reopened.getEntries().some(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolCallId === toolCallId &&
				!entry.message.isError,
		),
		false,
	);

	host.model.setResponses([
		fauxAssistantMessage("The successor Run received only fresh Agent input."),
	]);
	await authorMessageToAgent(
		host,
		view,
		child.agentId,
		"wake-successor-after-human-failure",
		"Start a successor without reconstructing Human input.",
		"deferred",
	);
	await waitForCondition(() =>
		child.session.sessionManager.getEntries().some(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "agent-coordination.message-delivery" &&
				String(entry.content).includes("Start a successor without reconstructing Human input."),
		),
	);
	await waitForCondition(() =>
		child.session.sessionManager.getEntries().some(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some(
					(part) => part.type === "text" &&
						part.text === "The successor Run received only fresh Agent input.",
				),
		),
	);
	reopened = SessionManager.open(sessionFile);
	assert.equal(
		inspectCommittedHumanRequestResult({ request, sessionManager: reopened }).state,
		"interrupted",
	);
	assert.equal(
		view.humanAttention().some((item) => item.requestId === attention.requestId),
		false,
	);

	await coordinator.shutdown(async () => host.runtime.dispose());
});

async function waitForCondition(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("Expected Human Request condition was not reached");
}

async function waitForInputRequired(
	view: ReturnType<WorkflowCoordinator["forAgent"]>,
	agentId: string,
): Promise<void> {
	await waitForCondition(() => {
		const run = view.status(agentId).run;
		return "attention" in run && run.attention === "input_required";
	});
}

async function spawnLiveChild(
	host: Awaited<ReturnType<typeof createUnboundTestOwnerHost>>,
	view: ReturnType<WorkflowCoordinator["forAgent"]>,
	childSessions: ReadonlyMap<string, AgentSession>,
	toolCallId: string,
	request: string,
): Promise<{ agentId: string; session: AgentSession }> {
	host.model.setResponses([
		fauxAssistantMessage("The Creation Request is retained for an Answer."),
	]);
	const input = { request };
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_spawn", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const receipt = await view.spawn(toolCallId, input);
	const childId = "agentId" in receipt ? receipt.agentId : undefined;
	if (typeof childId !== "string") throw new Error("Spawn receipt has no Agent identity");
	await waitForCondition(() => childSessions.has(childId));
	const session = childSessions.get(childId);
	if (!session) throw new Error("Spawned Agent session was not captured");
	await waitForCondition(() =>
		session.sessionManager.getEntries().some(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === "agent-coordination.message-delivery",
		),
	);
	await session.waitForIdle();
	return { agentId: childId, session };
}

function observedAttention(
	view: ReturnType<WorkflowCoordinator["forAgent"]>,
	agentId: string,
): "none" | "input_required" | "dormant" {
	const run = view.status(agentId).run;
	return "attention" in run ? run.attention : "dormant";
}

async function authorMessageToAgent(
	host: Awaited<ReturnType<typeof createUnboundTestOwnerHost>>,
	view: ReturnType<WorkflowCoordinator["forAgent"]>,
	targetAgentId: string,
	toolCallId: string,
	content: string,
	deliveryMode: "deferred" | "steer",
): Promise<void> {
	const input = {
		operation: "send" as const,
		targetAgentId,
		content,
		deliveryMode,
	};
	host.session.sessionManager.appendMessage(
		fauxAssistantMessage(
			fauxToolCall("agent_message", input, { id: toolCallId }),
			{ stopReason: "toolUse" },
		),
	);
	const receipt = await view.message(toolCallId, input);
	host.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName: "agent_message",
		content: [{ type: "text", text: JSON.stringify(receipt) }],
		details: receipt,
		isError: false,
		timestamp: Date.now(),
	});
}

function observeContinuation(
	messages: readonly unknown[],
	answerToolCallId: string,
): {
	answerIndex: number;
	deliveries: Array<{ index: number; content: string }>;
} {
	const typed = messages as Array<{
		role?: string;
		toolCallId?: string;
		content?: unknown;
	}>;
	const answerIndex = typed.findIndex(
		(message) =>
			message.role === "toolResult" &&
			message.toolCallId === answerToolCallId,
	);
	const deliveries: Array<{ index: number; content: string }> = [];
	for (let index = 0; index < typed.length; index += 1) {
		const message = typed[index]!;
		if (message.role !== "user" || !Array.isArray(message.content)) continue;
		const text = message.content.find(
			(part): part is { type: "text"; text: string } =>
				typeof part === "object" &&
				part !== null &&
				"type" in part &&
				part.type === "text" &&
				"text" in part &&
				typeof part.text === "string",
		);
		if (!text) continue;
		try {
			const parsed = JSON.parse(text.text) as {
				messages?: Array<{ kind?: string; content?: string }>;
			};
			for (const delivered of parsed.messages ?? []) {
				if (delivered.kind === "message" && typeof delivered.content === "string") {
					deliveries.push({ index, content: delivered.content });
				}
			}
		} catch {
			continue;
		}
	}
	return { answerIndex, deliveries };
}
