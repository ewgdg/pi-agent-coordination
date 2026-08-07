import assert from "node:assert/strict";
import test from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";

import {
	createAgentBoundExtension,
	createModeratorBoundExtension,
	createPresentationBoundExtension,
} from "../src/bootstrap/agent-extension.ts";
import type {
	HumanPresentationCoordinatorView,
	ModeratorAgentCoordinatorView,
	OrdinaryAgentCoordinatorView,
} from "../src/coordination/workflow-coordinator.ts";
import { createTestOwnerHost } from "./support/pi-host.ts";

const ordinaryTools = [
	"agent_control",
	"agent_message",
	"agent_observe",
	"agent_spawn",
	"ask_user_question",
] as const;
const moderatorTools = [
	"agent_control",
	"agent_message",
	"agent_observe",
	"ask_user_question",
	"moderator_control",
] as const;
const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

test("child session surfaces disable native session replacement", async (t) => {
	const unavailableView = () => {
		throw new Error("Child session command conformance does not execute coordination behavior");
	};
	const childSurfaces = [
		{
			name: "live",
			extension: createAgentBoundExtension(
				unavailableView as () => OrdinaryAgentCoordinatorView,
			),
		},
		{
			name: "dormant",
			extension: createPresentationBoundExtension(
				unavailableView as () => HumanPresentationCoordinatorView,
			),
		},
	] as const;

	for (const { name, extension } of childSurfaces) {
		await t.test(name, async () => {
			const host = await createTestOwnerHost(extension, { persistent: true });
			const sessionFile = host.session.sessionManager.getSessionFile();
			assert.ok(sessionFile);
			assert.deepEqual(
				await host.runtime.switchSession(sessionFile),
				{ cancelled: true },
			);
			assert.deepEqual(await host.runtime.fork("unused-entry"), { cancelled: true });
			assert.deepEqual(host.ui.notifications.slice(-2), [
				{
					message: "Return to Owner before replacing or forking the native session.",
					type: "error",
				},
				{
					message: "Return to Owner before replacing or forking the native session.",
					type: "error",
				},
			]);
			await host.runtime.dispose();
		});
	}
});

test("role-bound extensions expose strict sequential tools with compact native renderers", async (t) => {
	for (const role of ["ordinary", "moderator"] as const) {
		await t.test(role, async () => {
			const unavailableView = () => {
				throw new Error("Role conformance does not execute coordination behavior");
			};
			const extension = role === "ordinary"
				? createAgentBoundExtension(
					unavailableView as () => OrdinaryAgentCoordinatorView,
				)
				: createModeratorBoundExtension(
					unavailableView as () => ModeratorAgentCoordinatorView,
				);
			const host = await createTestOwnerHost(extension);
			const expectedTools = role === "ordinary" ? ordinaryTools : moderatorTools;
			assert.deepEqual(host.session.getActiveToolNames().sort(), [...expectedTools].sort());
			for (const toolName of expectedTools) {
				const tool = host.session.getToolDefinition(toolName);
				assert.ok(tool, toolName);
				assert.equal(tool.executionMode, "sequential", toolName);
				assert.equal(typeof tool.renderCall, "function", toolName);
				assert.equal(typeof tool.renderResult, "function", toolName);
				assertStrictObjectVariants(tool.parameters, toolName);
			}
			assert.equal(
				host.services.resourceLoader.getExtensions().extensions.length,
				1,
			);
			await host.runtime.dispose();
		});
	}
});

test("coordination renderers keep collapsed receipts to one bounded line", async () => {
	const unavailableView = () => {
		throw new Error("Renderer conformance does not execute coordination behavior");
	};
	const ordinaryHost = await createTestOwnerHost(
		createAgentBoundExtension(
			unavailableView as () => OrdinaryAgentCoordinatorView,
		),
	);
	const moderatorHost = await createTestOwnerHost(
		createModeratorBoundExtension(
			unavailableView as () => ModeratorAgentCoordinatorView,
		),
	);
	const cases = [
		{
			host: ordinaryHost,
			toolName: "agent_observe",
			args: { operation: "status", agentId: "child-agent" },
			details: {
				agentId: "child-agent",
				configuration: { label: "Researcher" },
				run: { phase: "live", work: "settled" },
			},
			summary: /child-agent/,
			expandedDetail: /Researcher/,
		},
		{
			host: ordinaryHost,
			toolName: "agent_control",
			args: { operation: "interrupt", agentId: "child-agent" },
			details: { agentId: "child-agent", disposition: "held" },
			summary: /held .* child-agent/,
			expandedDetail: /disposition/,
		},
		{
			host: ordinaryHost,
			toolName: "ask_user_question",
			args: {
				questions: [{
					kind: "text",
					header: "Decision",
					prompt: "Choose the authoritative boundary.",
					multiline: false,
				}],
			},
			details: {
				requestId: "human-request",
				answers: [{ kind: "text", text: "Native Pi" }],
			},
			summary: /answered .* 1 Question/,
			expandedDetail: /Native Pi/,
		},
		{
			host: moderatorHost,
			toolName: "moderator_control",
			args: {
				operation: "resolve",
				summary: "Progress restored.",
				rationale: "The blocked Run can continue.",
			},
			details: { disposition: "resolved" },
			summary: /resolved/,
			expandedDetail: /disposition/,
		},
	] as const;

	for (const sample of cases) {
		const tool = sample.host.session.getToolDefinition(sample.toolName);
		assert.ok(tool?.renderCall, sample.toolName);
		assert.ok(tool.renderResult, sample.toolName);
		const context = {
			args: sample.args,
			toolCallId: `render-${sample.toolName}`,
			invalidate() {},
			lastComponent: undefined,
			state: {},
			cwd: sample.host.cwd,
			argsComplete: true,
			isPartial: false,
			expanded: false,
			showImages: false,
			isError: false,
			executionStarted: true,
		};
		const call = tool.renderCall(sample.args, plainTheme, context).render(120);
		assert.equal(call.length, 1, sample.toolName);
		const collapsed = tool.renderResult(
			{
				content: [{ type: "text", text: JSON.stringify(sample.details) }],
				details: sample.details,
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			context,
		).render(120);
		assert.equal(collapsed.length, 1, sample.toolName);
		assert.match(collapsed[0]!, sample.summary, sample.toolName);
		assert.equal(collapsed[0]!.includes("{"), false, sample.toolName);

		const expanded = tool.renderResult(
			{
				content: [{ type: "text", text: JSON.stringify(sample.details) }],
				details: sample.details,
			},
			{ expanded: true, isPartial: false },
			plainTheme,
			context,
		).render(120).join("\n");
		assert.match(expanded, sample.expandedDetail, sample.toolName);
	}

	await ordinaryHost.runtime.dispose();
	await moderatorHost.runtime.dispose();
});

function assertStrictObjectVariants(schema: unknown, toolName: string): void {
	assert.ok(typeof schema === "object" && schema !== null, toolName);
	const record = schema as {
		additionalProperties?: unknown;
		anyOf?: Array<{ additionalProperties?: unknown }>;
	};
	const variants = record.anyOf ?? [record];
	assert.ok(variants.length > 0, toolName);
	for (const variant of variants) {
		assert.equal(variant.additionalProperties, false, toolName);
	}
}
