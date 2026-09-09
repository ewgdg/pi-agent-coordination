import type { Message } from "./message.ts";

export type WorkflowResumeDelivery = Readonly<{
	messageId: string;
	targetAgentId: string;
	kind: Message["kind"];
	disposition: "scheduled" | "skipped" | "blocked" | "indeterminate";
	reason?: string;
}>;

export type WorkflowResumeActivation = Readonly<{
	agentId: string;
	requestIds: readonly string[];
	disposition: "admitted" | "skipped" | "blocked" | "indeterminate";
	reason?: string;
}>;

export type WorkflowResumeReceipt = Readonly<{
	workflowId: string;
	deliveries: readonly WorkflowResumeDelivery[];
	activations: readonly WorkflowResumeActivation[];
	indeterminate: readonly Readonly<{ agentId: string; reason: string }>[];
}>;
