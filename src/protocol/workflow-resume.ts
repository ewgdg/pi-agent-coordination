export const WORKFLOW_RECOVERY_GUIDANCE = "outstandingRequests describes your own outbound Requests at recovery admission. continuation_admitted, already_running, and delivery_scheduled need no manual wake-up; admission is not Delivery or completion. Inspect blocked or indeterminate entries before targeted recovery. Do not send redundant wake-up Messages or replacement Requests; send only genuinely new instructions.";

export type OutstandingRequestRecovery = Readonly<{
	requestMessageId: string;
	targetAgentId: string;
	status: "continuation_admitted" | "already_running" | "delivery_scheduled" | "blocked" | "indeterminate" | "resolved";
	reason?: string;
}>;

export type WorkflowRecoveryView = Readonly<{
	outstandingRequests: readonly OutstandingRequestRecovery[];
}>;

export type WorkflowResumeReceipt = WorkflowRecoveryView & Readonly<{
	workflowId: string;
}>;
