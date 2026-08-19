import assert from "node:assert/strict";
import test from "node:test";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

import {
	registerOrdinaryAgentSurfaces,
} from "../src/tools/owner-surfaces.ts";
import {
	participantCoordinationToolSchemas,
	registerParticipantCoordinationTools,
	type ParticipantCoordinationRole,
	type ParticipantCoordinationToolHandlers,
} from "../src/tools/participant-coordination-tools.ts";
import type { OrdinaryAgentCoordinatorView } from "../src/coordination/workflow-coordinator.ts";
import {
	renderAgentTemplatePromptGuide,
} from "../src/tools/agent-template-prompt-guide.ts";
import {
	createTestOwnerHost,
	type TestCleanupRegistrar,
	type TestOwnerHost,
} from "./support/pi-host.ts";

const roleToolNames = {
	ordinary: [
		"agent_control",
		"agent_message",
		"agent_observe",
		"agent_wait",
		"agent_spawn",
		"ask_user_question",
	],
	moderator: [
		"agent_control",
		"agent_message",
		"agent_observe",
		"agent_wait",
		"ask_user_question",
		"moderator_control",
	],
	owner: [
		"agent_control",
		"agent_message",
		"agent_observe",
		"agent_wait",
		"agent_spawn",
	],
} as const;

const agentStatus = {
	agentId: "child-agent",
	workflowId: "workflow",
	label: "Child",
	directSpawnerAgentId: "owner",
	primaryEvidence: {
		transcriptPath: null,
		inspectedThrough: { agentId: "child-agent", entryId: "entry-1" },
	},
	run: { phase: "dormant", retentionReasons: [] },
} as const;

const handlers: ParticipantCoordinationToolHandlers<"ordinary"> &
	ParticipantCoordinationToolHandlers<"moderator"> &
	ParticipantCoordinationToolHandlers<"owner"> = {
	async message() {
		return { messageId: "message-1", messageStatus: "sent" };
	},
	async wait() {
		return { answers: [] };
	},
	async spawn() {
		return {
			spawnStatus: "not_created",
			failedStage: "identity_commit",
			reason: "Test child was not created",
		};
	},
	async agentTemplateSnapshot() {
		return {
			currentRuntime: {
				model: { provider: "test", modelId: "model" },
				thinking: "off",
			},
			templates: [],
		};
	},
	async observe() {
		return agentStatus;
	},
	async control() {
		return { agentId: "child-agent", disposition: "not_running" };
	},
	async askUserQuestion() {
		return { requestId: "request-1", answer: "Answer" };
	},
	async moderatorControl() {
		return { disposition: "resolved" };
	},
};

test("participant registrar exposes the exact closed sequential role tool sets", async (t) => {
	for (const role of ["ordinary", "moderator", "owner"] as const) {
		await t.test(role, async (t) => {
			const host = await createRegistrarHost(t, role, handlers);
			assert.deepEqual(
				host.session.getActiveToolNames().sort(),
				[...roleToolNames[role]].sort(),
			);
			for (const toolName of roleToolNames[role]) {
				const tool = host.session.getToolDefinition(toolName);
				assert.ok(tool, toolName);
				assert.equal(tool.executionMode, "sequential", toolName);
				assert.equal(tool.parameters, participantCoordinationToolSchemas[toolName]);
				assertClosedTypeBoxObjects(tool.parameters, toolName);
				assert.equal(typeof tool.renderCall, "function", toolName);
				assert.equal(typeof tool.renderResult, "function", toolName);
			}
			assert.equal(host.session.extensionRunner.getCommand("agents"), undefined);
			await host.runtime.dispose();
		});
	}
});

test("Agent Message schema correlates Answer implicitly and Cancellation explicitly", () => {
	const variants = (participantCoordinationToolSchemas.agent_message as {
		anyOf: Array<{ properties: Record<string, { const?: string }> }>;
	}).anyOf;
	const answer = variants.find(({ properties }) =>
		properties.operation?.const === "answer"
	);
	assert.ok(answer);
	assert.deepEqual(Object.keys(answer.properties).sort(), ["answer", "operation"]);

	const cancellation = variants.find(({ properties }) =>
		properties.operation?.const === "cancel"
	);
	assert.ok(cancellation);
	assert.equal("requestMessageId" in cancellation.properties, true);
	assert.equal("requestId" in cancellation.properties, false);
});

test("Agent Wait schema accepts only a parameterless join", () => {
	const schema = participantCoordinationToolSchemas.agent_wait;
	assert.equal(Value.Check(schema, {}), true);
	assert.equal(Value.Check(schema, {
		requestMessageIds: ["request-a"],
	}), false);
});

test("Agent Observe schema composes authorized and direct-child search filters", () => {
	const schema = participantCoordinationToolSchemas.agent_observe;
	assert.equal(Value.Check(schema, { operation: "status" }), true);
	assert.equal(Value.Check(schema, {
		operation: "search",
		scope: "direct_children",
	}), true);
	assert.equal(Value.Check(schema, {
		operation: "search",
		scope: { directSpawnerAgentId: "parent-agent" },
		query: "review",
		agentIdSuffix: "a1b2c3d4",
		phase: "dormant",
		limit: 50,
	}), true);
	assert.equal(Value.Check(schema, {
		operation: "search",
		scope: "authorized",
		phase: "live",
	}), true);
	assert.equal(Value.Check(schema, {
		operation: "search",
		scope: "authorized",
	}), false);
	assert.equal(Value.Check(schema, {
		operation: "search",
		scope: "authorized",
		query: " ",
	}), false);
	assert.equal(Value.Check(schema, {
		operation: "search",
		scope: { directSpawnerAgentId: " " },
	}), false);
	assert.equal(Value.Check(schema, {
		operation: "children",
	}), false);
	assert.equal(Value.Check(schema, {
		operation: "search",
		scope: "direct_children",
		limit: 51,
	}), false);
});

test("Agent Spawn schema accepts conversation forks and rejects extension path arrays", () => {
	const schema = participantCoordinationToolSchemas.agent_spawn;
	assert.equal(Value.Check(schema, {
		request: "Continue the completed conversation.",
		conversation: "fork",
	}), true);
	assert.equal(Value.Check(schema, {
		request: "Do not accept unknown conversation modes.",
		conversation: "copy",
	}), false);
	assert.equal(Value.Check(schema, {
		request: "Do not configure a conversation fork.",
		conversation: "fork",
		config: { allowedTools: ["read"] },
	}), false);
	assert.equal(Value.Check(schema, {
		request: "Do not select a Template for a conversation fork.",
		conversation: "fork",
		template: "reviewer",
	}), false);
	assert.equal(Value.Check(schema, {
		request: "Inspect the child Runtime.",
		config: { extensions: "inherit" },
	}), true);
	assert.equal(Value.Check(schema, {
		request: "Inspect the child Runtime.",
		config: { extensions: ["/extensions/arbitrary.ts"] },
	}), false);
});

test("Template catalogue shows current Runtime and available Template configuration", () => {
	const catalogue = renderAgentTemplatePromptGuide({
		currentRuntime: {
			model: { provider: "current", modelId: "model" },
			thinking: "low",
		},
		templates: [
		{
			name: "integration-researcher",
			useWhen: "Use for integration research requiring primary sources.",
			models: [
				{
					model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
					thinking: "high",
				},
				{
					model: { provider: "deepseek", modelId: "deepseek-v4-flash" },
					thinking: "medium",
				},
			],
			allowedTools: ["read", "bash"],
			skills: ["research"],
			extensions: "none",
			systemPromptMode: "replace",
			inheritProjectContext: false,
		},
		{
			name: "plain-agent",
			systemPromptMode: "append",
			inheritProjectContext: true,
		},
		],
	});

	assert.match(catalogue ?? "", /integration-researcher/);
	assert.match(catalogue ?? "", /Use for integration research requiring primary sources\./);
	assert.match(catalogue ?? "", /anthropic\/claude-sonnet-4-5/);
	assert.match(catalogue ?? "", /systemPromptMode: replace/);
	assert.match(catalogue ?? "", /- name: plain-agent\n  systemPromptMode: append/);
	assert.match(catalogue, /## Current Agent Runtime/);
	assert.match(catalogue, /id: current\/model/);
});

test("Agent Spawn prompt guideline exposes the prepared Runtime Template catalogue", async (t) => {
	let observedSystemPrompt = "";
	const templateSnapshot = {
		currentRuntime: {
			model: { provider: "current", modelId: "model" },
			thinking: "low" as const,
		},
		templates: [{
			name: "integration-researcher",
			useWhen: "Use for integration research.",
			models: [{
				model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
				thinking: "high" as const,
			}],
			systemPromptMode: "append" as const,
			inheritProjectContext: true,
		}],
	};
	const host = await createTestOwnerHost(t, (pi) => {
		registerParticipantCoordinationTools(
			pi,
			"owner",
			handlers,
			undefined,
			templateSnapshot,
		);
	});
	const spawn = host.session.getToolDefinition("agent_spawn");
	assert.ok(spawn);
	assert.equal(
		spawn.promptGuidelines?.some((guideline) =>
			guideline.includes("integration-researcher")
		),
		true,
	);
	host.model.setResponses([(context) => {
		observedSystemPrompt = context.systemPrompt ?? "";
		return fauxAssistantMessage("Done.");
	}]);

	await host.session.prompt("Choose an Agent Template if appropriate.");
	assert.match(observedSystemPrompt, /## Available Agent Templates/);
	assert.match(observedSystemPrompt, /integration-researcher/);
	assert.match(observedSystemPrompt, /thinking: high/);
	await host.runtime.dispose();
});

test("participant registrar contributes one shared asynchronous Agent control guide", async (t) => {
	let observedSystemPrompt = "";
	const host = await createRegistrarHost(t, "ordinary", handlers);
	const message = host.session.getToolDefinition("agent_message");
	const wait = host.session.getToolDefinition("agent_wait");
	const spawn = host.session.getToolDefinition("agent_spawn");
	assert.ok(message);
	assert.ok(wait);
	assert.ok(spawn);
	assert.equal(message.promptGuidelines?.length, 1);
	assert.equal(wait.promptGuidelines?.length, 1);
	assert.equal(spawn.promptGuidelines?.length, 2);
	assert.equal(wait.promptGuidelines[0], message.promptGuidelines[0]);
	assert.equal(spawn.promptGuidelines[0], message.promptGuidelines[0]);
	assert.match(
		spawn.promptGuidelines[1] ?? "",
		/Use agent_spawn `conversation: "fork"` only for a cache-affine continuation/,
	);
	host.model.setResponses([(context) => {
		observedSystemPrompt = context.systemPrompt ?? "";
		return fauxAssistantMessage("Done.");
	}]);

	await host.session.prompt("Inspect the Agent tool guidance.");
	assert.equal(observedSystemPrompt.split("<agent_control>").length - 1, 1);
	assert.equal(observedSystemPrompt.split("</agent_control>").length - 1, 1);
	const requiredRules: ReadonlyArray<readonly [string, RegExp]> = [
		[
			"treat successful sends as asynchronous admission",
			/messageStatus "sent"[\s\S]*may still be queued[\s\S]*does not mean delivered/,
		],
		[
			"make delivered Requests create Answer obligations",
			/delivered Agent Request[\s\S]*creates one Answer obligation/,
		],
		[
			"settle when Answers can be handled independently",
			/Answers can be handled independently[\s\S]*end the turn[\s\S]*arrive automatically/,
		],
		[
			"reserve Agent Wait for strict fan-in",
			/one next decision requires every outstanding Answer together[\s\S]*avoiding one model turn per Answer matters/,
		],
		[
			"ordinary Messages do not resolve Agent Requests",
			/Ordinary Messages do not satisfy Agent Requests/,
		],
		[
			"preserve Answers across wait preemption",
			/agent_wait returns disposition "preempted"[\s\S]*call agent_wait again[\s\S]*preemption does not consume[\s\S]*Answer Delivery proof/,
		],
		[
			"keep provisional responder work off the Message lane",
			/Keep provisional findings local[\s\S]*Use "answer" for the curated result[\s\S]*reverse "request"/,
		],
		[
			"make Answer the terminal responder output",
			/terminal response to that Request[\s\S]*end the turn immediately[\s\S]*Agent Run settles/,
		],
	];
	for (const [intent, pattern] of requiredRules) {
		assert.match(observedSystemPrompt, pattern, intent);
	}
	await host.runtime.dispose();
});

test("participant registrar preserves role-specific tool presentation metadata", async (t) => {
	const ordinary = await createRegistrarHost(t, "ordinary", handlers);
	const moderator = await createRegistrarHost(t, "moderator", handlers);
	const owner = await createRegistrarHost(t, "owner", handlers);

	assert.deepEqual(toolMetadata(ordinary, "agent_message"), {
		label: "Message Agent",
		description:
			"Send one immutable Message or correlated Request to a known Agent in this Workflow.",
		promptSnippet: "Send, request, answer, cancel, poll, or retry direct Agent communication.",
		renderShell: undefined,
	});
	assert.deepEqual(toolMetadata(ordinary, "agent_wait"), {
		label: "Wait for Answers",
		description:
			"Wait until every outstanding outbound Agent Request has a committed Answer, unless an inbound Agent Request preempts the wait for attention.",
		promptSnippet:
			"Join all outstanding Agent Request Answers unless an inbound Agent Request preempts the wait.",
		renderShell: undefined,
	});
	assert.deepEqual(toolMetadata(ordinary, "agent_spawn"), {
		label: "Spawn Agent",
		description:
			"Create one fresh durable child Agent with isolated context or a cache-affine conversation fork, then deliver its initial Creation Request.",
		promptSnippet:
			"Create a fresh child Agent with isolated work or a cache-affine conversation fork.",
		renderShell: undefined,
	});
	assert.deepEqual(toolMetadata(ordinary, "agent_observe"), {
		label: "Observe Agent",
		description: "Passively observe an authorized Agent or search its authorized Agent scope.",
		promptSnippet: "Observe exact status or search authorized Agents by metadata and Run phase.",
		renderShell: undefined,
	});
	assert.deepEqual(toolMetadata(moderator, "agent_observe"), {
		label: "Observe Agent",
		description:
			"Passively observe any known Agent in this Workflow or search authorized Agent scopes.",
		promptSnippet:
			"Pull bounded status or search results for Workflow Agents relevant to diagnosis.",
		renderShell: undefined,
	});
	assert.deepEqual(toolMetadata(ordinary, "agent_control"), {
		label: "Control Agent Run",
		description:
			"Interrupt, explicitly resume, or terminate one authorized exact Agent Run.",
		promptSnippet:
			"Supervise an immediate child Run, or any non-Owner Run when acting as Workflow Owner.",
		renderShell: undefined,
	});
	assert.deepEqual(toolMetadata(moderator, "agent_control"), {
		label: "Control Agent Run",
		description:
			"Interrupt, explicitly resume, or terminate one authorized exact Agent Run.",
		promptSnippet: "Supervise any current non-Owner Run needed to restore safe progress.",
		renderShell: undefined,
	});
	assert.deepEqual(toolMetadata(ordinary, "ask_user_question"), {
		label: "Ask User",
		description:
			"Ask the human one nonblank free-form question and wait for one nonblank free-form Answer.",
		promptSnippet:
			"Block until the human supplies judgment through this Agent's native editor.",
		renderShell: "self",
	});
	assert.deepEqual(toolMetadata(moderator, "moderator_control"), {
		label: "Control Moderation",
		description:
			"Renew an exact Operation Review interval or resolve handling after every mechanically checkable predicate clears. A Run Failure clears as soon as a successor Run starts; any remaining Answer Obligation is ordinary Workflow work.",
		promptSnippet:
			"Renew an exact reviewed call deliberately, or resolve immediately when the original condition clears.",
		renderShell: undefined,
	});
	assert.deepEqual(toolMetadata(owner, "agent_observe"), toolMetadata(ordinary, "agent_observe"));

	await Promise.all([
		ordinary.runtime.dispose(),
		moderator.runtime.dispose(),
		owner.runtime.dispose(),
	]);
});

test("participant registrar routes intents and returns exact handler receipts", async (t) => {
	const calls: unknown[] = [];
	const updates: unknown[] = [];
	const waitProgress = {
		waitingFor: [{
			requestMessageId: "request-waiting",
			responderAgentId: "child-agent",
		}],
	} as const;
	const messageReceipt = { messageId: "message-2", messageStatus: "sent" } as const;
	const waitReceipt = { answers: [] } as const;
	const spawnReceipt = {
		spawnStatus: "not_created",
		failedStage: "identity_commit",
		reason: "Test child was not created",
	} as const;
	const observeReceipt = { matches: [agentStatus], hasMore: false } as const;
	const controlReceipt = { agentId: "child-agent", disposition: "held" } as const;
	const humanReceipt = { requestId: "human-1", answer: "Proceed." } as const;
	const signal = new AbortController().signal;
	const routedHandlers: ParticipantCoordinationToolHandlers<"ordinary"> = {
		async message(toolCallId, input) {
			calls.push(["message", toolCallId, input]);
			return messageReceipt;
		},
		async wait(toolCallId, input, receivedSignal, onProgress) {
			calls.push(["wait", toolCallId, input, receivedSignal]);
			onProgress?.(waitProgress);
			return waitReceipt;
		},
		async spawn(toolCallId, input) {
			calls.push(["spawn", toolCallId, input]);
			return spawnReceipt;
		},
		async agentTemplateSnapshot() {
			return handlers.agentTemplateSnapshot();
		},
		async observe(input) {
			calls.push(["observe", input]);
			return observeReceipt;
		},
		async control(toolCallId, input) {
			calls.push(["control", toolCallId, input]);
			return controlReceipt;
		},
		async askUserQuestion(toolCallId, input, receivedSignal) {
			calls.push(["ask", toolCallId, input, receivedSignal]);
			return humanReceipt;
		},
	};
	const host = await createRegistrarHost(t, "ordinary", routedHandlers);
	const samples = [
		["agent_message", "call-message", { operation: "poll", messageId: "message-1" }, messageReceipt],
		["agent_wait", "call-wait", {}, waitReceipt],
		["agent_spawn", "call-spawn", { request: "Investigate." }, spawnReceipt],
		[
			"agent_observe",
			"call-observe",
			{ operation: "search", scope: "direct_children" },
			observeReceipt,
		],
		["agent_control", "call-control", { operation: "interrupt", agentId: "child-agent" }, controlReceipt],
		["ask_user_question", "call-human", { question: "Proceed?" }, humanReceipt],
	] as const;
	for (const [toolName, toolCallId, input, receipt] of samples) {
		const result = await executeTool(
			host,
			toolName,
			toolCallId,
			input,
			signal,
			toolName === "agent_wait" ? (update) => updates.push(update) : undefined,
		);
		assert.equal(result.details, receipt, toolName);
		assert.deepEqual(result.content, [
			{ type: "text", text: JSON.stringify(receipt) },
		], toolName);
	}
	assert.deepEqual(updates, [{
		content: [{ type: "text", text: "Waiting for 1 Agent Answer." }],
		details: waitProgress,
	}]);
	assert.deepEqual(calls, [
		["message", "call-message", samples[0][2]],
		["wait", "call-wait", samples[1][2], signal],
		["spawn", "call-spawn", samples[2][2]],
		["observe", samples[3][2]],
		["control", "call-control", samples[4][2]],
		["ask", "call-human", samples[5][2], signal],
	]);
	await host.runtime.dispose();
});

test("participant registrar preserves handler errors and Moderator control routing", async (t) => {
	const failure = new Error("exact coordinator rejection");
	const moderatorReceipt = { disposition: "resolved" } as const;
	let moderatorCall: unknown;
	const moderatorHandlers: ParticipantCoordinationToolHandlers<"moderator"> = {
		...handlers,
		async control() {
			throw failure;
		},
		async moderatorControl(toolCallId, input) {
			moderatorCall = [toolCallId, input];
			return moderatorReceipt;
		},
	};
	const host = await createRegistrarHost(t, "moderator", moderatorHandlers);
	await assert.rejects(
		executeTool(
			host,
			"agent_control",
			"call-failure",
			{ operation: "terminate", agentId: "child-agent" },
		),
		(error) => error === failure,
	);
	const input = {
		operation: "resolve",
		summary: "Progress restored.",
		rationale: "The exact predicate cleared.",
	} as const;
	const result = await executeTool(host, "moderator_control", "call-moderator", input);
	assert.deepEqual(moderatorCall, ["call-moderator", input]);
	assert.equal(result.details, moderatorReceipt);
	assert.deepEqual(result.content, [
		{ type: "text", text: JSON.stringify(moderatorReceipt) },
	]);
	await host.runtime.dispose();
});

test("ordinary surface composes its prepared Template snapshot and /agents with the participant registrar", async (t) => {
	const direct = await createRegistrarHost(t, "ordinary", handlers);
	const preparedView = () => ({
		agentTemplateSnapshot: () => ({
			currentRuntime: {
				model: { provider: "test", modelId: "model" },
				thinking: "off" as const,
			},
			templates: [],
		}),
	}) as unknown as OrdinaryAgentCoordinatorView;
	const composed = await createTestOwnerHost(t, (pi) => {
		registerOrdinaryAgentSurfaces(pi, preparedView);
	});

	assert.ok(composed.session.extensionRunner.getCommand("agents"));
	assert.deepEqual(
		composed.session.getActiveToolNames().sort(),
		[...roleToolNames.ordinary].sort(),
	);
	for (const toolName of roleToolNames.ordinary) {
		const directTool = direct.session.getToolDefinition(toolName);
		const composedTool = composed.session.getToolDefinition(toolName);
		assert.ok(directTool, toolName);
		assert.ok(composedTool, toolName);
		assert.equal(composedTool.parameters, directTool.parameters, toolName);
		assert.equal(typeof composedTool.renderCall, typeof directTool.renderCall, toolName);
		assert.equal(typeof composedTool.renderResult, typeof directTool.renderResult, toolName);
	}

	await Promise.all([direct.runtime.dispose(), composed.runtime.dispose()]);
});

async function createRegistrarHost<Role extends ParticipantCoordinationRole>(
	t: TestCleanupRegistrar,
	role: Role,
	roleHandlers: ParticipantCoordinationToolHandlers<Role>,
): Promise<TestOwnerHost> {
	return createTestOwnerHost(t, (pi: ExtensionAPI) => {
		registerParticipantCoordinationTools(pi, role, roleHandlers);
	});
}

async function executeTool(
	host: TestOwnerHost,
	toolName: string,
	toolCallId: string,
	input: unknown,
	signal?: AbortSignal,
	onUpdate?: (update: unknown) => void,
) {
	const tool = host.session.getToolDefinition(toolName);
	assert.ok(tool, toolName);
	return tool.execute(
		toolCallId,
		input,
		signal,
		onUpdate,
		host.session.extensionRunner.createContext(),
	);
}

function toolMetadata(host: TestOwnerHost, toolName: string) {
	const tool = host.session.getToolDefinition(toolName);
	assert.ok(tool, toolName);
	return {
		label: tool.label,
		description: tool.description,
		promptSnippet: tool.promptSnippet,
		renderShell: tool.renderShell,
	};
}

function assertClosedTypeBoxObjects(schema: unknown, path: string): void {
	if (typeof schema !== "object" || schema === null) return;
	const node = schema as {
		type?: unknown;
		additionalProperties?: unknown;
		anyOf?: unknown[];
		properties?: Record<string, unknown>;
		items?: unknown;
	};
	if (node.type === "object") {
		assert.equal(node.type, "object", path);
		if (!node.anyOf) assert.equal(node.additionalProperties, false, path);
	}
	for (const [index, variant] of (node.anyOf ?? []).entries()) {
		assertClosedTypeBoxObjects(variant, `${path}.anyOf[${index}]`);
	}
	for (const [property, child] of Object.entries(node.properties ?? {})) {
		assertClosedTypeBoxObjects(child, `${path}.${property}`);
	}
	if (node.items) assertClosedTypeBoxObjects(node.items, `${path}.items`);
}
