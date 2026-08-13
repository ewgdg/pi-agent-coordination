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
	registerAgentTemplateCataloguePrompt,
	renderAgentTemplateCatalogue,
} from "../src/tools/agent-template-catalogue-prompt.ts";
import {
	createTestOwnerHost,
	type TestOwnerHost,
} from "./support/pi-host.ts";

const roleToolNames = {
	ordinary: [
		"agent_control",
		"agent_message",
		"agent_observe",
		"agent_spawn",
		"ask_user_question",
	],
	moderator: [
		"agent_control",
		"agent_message",
		"agent_observe",
		"ask_user_question",
		"moderator_control",
	],
	owner: [
		"agent_control",
		"agent_message",
		"agent_observe",
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
		return { messageId: "message-1", delivery: "pending" };
	},
	async spawn() {
		return { disposition: "not_created", failedStage: "identity_commit" };
	},
	async availableTemplates() {
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
		await t.test(role, async () => {
			const host = await createRegistrarHost(role, handlers);
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

test("Agent Spawn schema rejects extension path arrays", () => {
	const schema = participantCoordinationToolSchemas.agent_spawn;
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
	const catalogue = renderAgentTemplateCatalogue({
		currentRuntime: {
			model: { provider: "current", modelId: "model" },
			thinking: "low",
		},
		templates: [
		{
			name: "integration-researcher",
			selectionGuide: "Use for integration research requiring primary sources.",
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
			projectContextMode: "replace",
		},
		{
			name: "plain-agent",
			projectContextMode: "append",
		},
		],
	});

	assert.match(catalogue ?? "", /integration-researcher/);
	assert.match(catalogue ?? "", /Use for integration research requiring primary sources\./);
	assert.match(catalogue ?? "", /anthropic\/claude-sonnet-4-5/);
	assert.match(catalogue ?? "", /project-context: replace/);
	assert.match(catalogue ?? "", /- name: plain-agent\n  project-context: append/);
	assert.match(catalogue, /## Current Agent Runtime/);
	assert.match(catalogue, /id: current\/model/);
});

test("Template catalogue is injected into the model prompt", async () => {
	let observedSystemPrompt = "";
	const host = await createTestOwnerHost((pi) => {
		registerAgentTemplateCataloguePrompt(pi, async () => ({
			currentRuntime: {
				model: { provider: "current", modelId: "model" },
				thinking: "low",
			},
			templates: [{
				name: "integration-researcher",
				selectionGuide: "Use for integration research.",
				models: [{
					model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
					thinking: "high",
				}],
				projectContextMode: "append",
			}],
		}));
	});
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

test("participant registrar preserves role-specific tool presentation metadata", async () => {
	const ordinary = await createRegistrarHost("ordinary", handlers);
	const moderator = await createRegistrarHost("moderator", handlers);
	const owner = await createRegistrarHost("owner", handlers);

	assert.deepEqual(toolMetadata(ordinary, "agent_message"), {
		label: "Message Agent",
		description:
			"Send one immutable Message or correlated Request to a known Agent in this Workflow.",
		promptSnippet: "Send, request, answer, cancel, poll, or retry direct Agent communication.",
		renderShell: undefined,
	});
	assert.deepEqual(toolMetadata(ordinary, "agent_spawn"), {
		label: "Spawn Agent",
		description:
			"Create one fresh durable child Agent with inherited runtime configuration and deliver its initial Creation Request.",
		promptSnippet: "Create one fresh child Agent and give it isolated initial work.",
		renderShell: undefined,
	});
	assert.deepEqual(toolMetadata(ordinary, "agent_observe"), {
		label: "Observe Agent",
		description: "Passively observe an authorized Agent or its direct children.",
		promptSnippet: "Observe authorized Agents and their bounded live Run state.",
		renderShell: undefined,
	});
	assert.deepEqual(toolMetadata(moderator, "agent_observe"), {
		label: "Observe Agent",
		description:
			"Passively observe any known Agent in this Workflow or enumerate ordinary children.",
		promptSnippet: "Pull bounded status for Workflow Agents relevant to diagnosis.",
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

test("participant registrar routes intents and returns exact handler receipts", async () => {
	const calls: unknown[] = [];
	const messageReceipt = { messageId: "message-2", delivery: "pending" } as const;
	const spawnReceipt = {
		disposition: "not_created",
		failedStage: "identity_commit",
	} as const;
	const observeReceipt = { children: [agentStatus] } as const;
	const controlReceipt = { agentId: "child-agent", disposition: "held" } as const;
	const humanReceipt = { requestId: "human-1", answer: "Proceed." } as const;
	const signal = new AbortController().signal;
	const routedHandlers: ParticipantCoordinationToolHandlers<"ordinary"> = {
		async message(toolCallId, input) {
			calls.push(["message", toolCallId, input]);
			return messageReceipt;
		},
		async spawn(toolCallId, input) {
			calls.push(["spawn", toolCallId, input]);
			return spawnReceipt;
		},
		async availableTemplates() {
			return handlers.availableTemplates();
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
	const host = await createRegistrarHost("ordinary", routedHandlers);
	const samples = [
		["agent_message", "call-message", { operation: "poll", messageId: "message-1" }, messageReceipt],
		["agent_spawn", "call-spawn", { request: "Investigate." }, spawnReceipt],
		["agent_observe", "call-observe", { operation: "children" }, observeReceipt],
		["agent_control", "call-control", { operation: "interrupt", agentId: "child-agent" }, controlReceipt],
		["ask_user_question", "call-human", { question: "Proceed?" }, humanReceipt],
	] as const;
	for (const [toolName, toolCallId, input, receipt] of samples) {
		const result = await executeTool(host, toolName, toolCallId, input, signal);
		assert.equal(result.details, receipt, toolName);
		assert.deepEqual(result.content, [
			{ type: "text", text: JSON.stringify(receipt) },
		], toolName);
	}
	assert.deepEqual(calls, [
		["message", "call-message", samples[0][2]],
		["spawn", "call-spawn", samples[1][2]],
		["observe", samples[2][2]],
		["control", "call-control", samples[3][2]],
		["ask", "call-human", samples[4][2], signal],
	]);
	await host.runtime.dispose();
});

test("participant registrar preserves handler errors and Moderator control routing", async () => {
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
	const host = await createRegistrarHost("moderator", moderatorHandlers);
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

test("ordinary surface composes the participant registrar with /agents without changing renderers", async () => {
	const direct = await createRegistrarHost("ordinary", handlers);
	const unavailableView = () => {
		throw new Error("Surface composition does not resolve CoordinatorView");
	};
	const composed = await createTestOwnerHost((pi) => {
		registerOrdinaryAgentSurfaces(
			pi,
			unavailableView as () => OrdinaryAgentCoordinatorView,
		);
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
		assert.equal(composedTool.renderCall, directTool.renderCall, toolName);
		assert.equal(composedTool.renderResult, directTool.renderResult, toolName);
	}

	await Promise.all([direct.runtime.dispose(), composed.runtime.dispose()]);
});

async function createRegistrarHost<Role extends ParticipantCoordinationRole>(
	role: Role,
	roleHandlers: ParticipantCoordinationToolHandlers<Role>,
): Promise<TestOwnerHost> {
	return createTestOwnerHost((pi: ExtensionAPI) => {
		registerParticipantCoordinationTools(pi, role, roleHandlers);
	});
}

async function executeTool(
	host: TestOwnerHost,
	toolName: string,
	toolCallId: string,
	input: unknown,
	signal?: AbortSignal,
) {
	const tool = host.session.getToolDefinition(toolName);
	assert.ok(tool, toolName);
	return tool.execute(
		toolCallId,
		input,
		signal,
		undefined,
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
