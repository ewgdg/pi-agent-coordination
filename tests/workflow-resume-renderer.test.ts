import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerParticipantCoordinationTools } from "../src/tools/participant-coordination-tools.ts";
import type { WorkflowResumeReceipt } from "../src/protocol/workflow-resume.ts";

let resumeTool: ToolDefinition;
registerParticipantCoordinationTools({
	registerTool(tool: ToolDefinition) {
		if (tool.name === "workflow_resume") resumeTool = tool;
	},
} as ExtensionAPI, "owner", {} as Parameters<typeof registerParticipantCoordinationTools<"owner">>[2]);

const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bold: (text: string) => `<bold>${text}</bold>`,
} as Theme;
const context = {
	args: {}, lastComponent: undefined, toolCallId: "resume", invalidate() {}, state: {}, cwd: process.cwd(),
	argsComplete: true, isPartial: false, expanded: false, showImages: false,
	isError: false, executionStarted: true,
};
const receipt: WorkflowResumeReceipt = {
	workflowId: "workflow-full-id",
	outstandingRequests: [],
	deliveries: [{ messageId: "message-full-id", targetAgentId: "target-full-id", kind: "request", disposition: "scheduled" }],
	activations: [{ agentId: "responder-full-id", requestIds: ["request-full-id"], disposition: "admitted" }],
	indeterminate: [],
};
function rendered(details: WorkflowResumeReceipt | undefined, expanded = false, isPartial = false, error?: string) {
	return resumeTool.renderResult!(
		{ content: [{ type: "text", text: error ?? JSON.stringify(details) ?? "" }], details },
		{ expanded, isPartial }, theme, { ...context, isError: !!error },
	).render(240).join("\n");
}

test("registered Workflow Resume uses a themed call and compact admission receipt", () => {
	const call = resumeTool.renderCall!({}, theme, context).render(120).join("\n");
	assert.match(call, /<toolTitle><bold>/);
	assert.match(call, /resume/);
	const output = rendered(receipt);
	assert.match(output, /admission/i);
	assert.match(output, /1 Message scheduled/);
	assert.match(output, /1 responder admitted/);
	assert.doesNotMatch(output, /"workflowId"|message-full-id|completed|delivered/);
	const expanded = rendered(receipt, true);
	for (const id of ["workflow-full-id", "message-full-id", "target-full-id", "responder-full-id", "request-full-id"]) {
		assert.ok(expanded.includes(id), id);
	}
});

test("Workflow Resume surfaces skips, blocked and indeterminate work without claiming success", () => {
	const mixedReceipt: WorkflowResumeReceipt = {
		...receipt,
		deliveries: [
			...receipt.deliveries,
			{ ...receipt.deliveries[0]!, disposition: "skipped", reason: "resolved" },
			{ ...receipt.deliveries[0]!, disposition: "blocked", reason: "capacity" },
			{ ...receipt.deliveries[0]!, disposition: "indeterminate", reason: "unreadable" },
		],
		activations: [{ ...receipt.activations[0]!, disposition: "blocked", reason: "held" }],
		indeterminate: [{ agentId: "unreadable-agent", reason: "evidence unavailable" }],
	};
	const output = rendered(mixedReceipt);
	const expanded = rendered(mixedReceipt, true);
	for (const reason of ["resolved", "capacity", "unreadable", "held", "evidence unavailable"]) {
		assert.ok(expanded.includes(reason), reason);
	}
	assert.match(output, /1 skipped/);
	assert.match(output, /2 blocked/);
	assert.match(output, /2 indeterminate/);
	assert.match(output, /<warning>/);
	assert.match(rendered({ ...receipt, deliveries: [], activations: [] }), /no eligible work admitted/i);
});

test("Workflow Resume renders pending and tool errors rather than undefined JSON", () => {
	assert.match(rendered(undefined, false, true), /<warning>.*resuming/i);
	const output = rendered(undefined, false, false, "admission_closed: shutting down");
	assert.match(output, /<error>/);
	assert.match(output, /admission_closed: shutting down/);
	assert.doesNotMatch(output, /undefined|scheduled|admitted/);
});

test("Workflow Resume guidance explains automatic continuation, not completion or redundant wake-ups", () => {
	assert.match(resumeTool.description, /scheduling eligible pending/i);
	assert.match(resumeTool.description, /not Delivery or completion/i);
	const guide = resumeTool.promptGuidelines!.join("\n");
	assert.match(guide, /wake-up/i);
	assert.match(guide, /do not send redundant/i);
	assert.match(guide, /genuinely new instructions/i);
	assert.match(guide, /blocked.*indeterminate/i);
	assert.match(guide, /Interrupted tools and volatile Wait calls are not restored/i);
});
