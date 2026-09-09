import type { Message } from "../protocol/message.ts";

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

