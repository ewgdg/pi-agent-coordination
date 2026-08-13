import type { ToolCallPointer } from "../protocol/identities.ts";

type DeliveryAdmissionReceipt =
	| Readonly<{ delivery: "pending" | "indeterminate" }>
	| Readonly<{
		delivery: "rejected";
		rejectionReason:
			| "target_unavailable"
			| "host_shutting_down"
			| "capacity_exhausted";
	}>;

export type AgentMessageSendReceipt =
	Readonly<{ messageId: string }> & DeliveryAdmissionReceipt;

export type AgentRequestReceipt =
	Readonly<{ messageId: string; requestId: string }> & DeliveryAdmissionReceipt;

export type AgentAnswerReceipt =
	| Readonly<{
		messageId: string;
		requestId: string;
		delivery: "pending" | "indeterminate";
	}>
	| Readonly<{
		messageId: string;
		requestId: string;
		delivery: "rejected";
		rejectionReason:
			| "target_unavailable"
			| "host_shutting_down"
			| "capacity_exhausted";
	}>
	| Readonly<{
		messageId: string;
		requestId: string;
		answerId: string;
		disposition: "already_answered";
	}>
	| Readonly<{
		messageId: string;
		requestId: string;
		cancellationId: string;
		disposition: "already_cancelled";
	}>;

export type RequestCancellationReceipt =
	| AgentMessageSendReceipt
	| Readonly<{
		disposition: "already_cancelled";
		cancellationMessageId: string;
	}>
	| Readonly<{
		disposition: "already_answered";
		answerMessageId: string;
	}>;

export type AgentMessagePollReceipt =
	| Readonly<{
		disposition: "delivered";
		messageId: string;
		deliveryEvidence: Readonly<{ agentId: string; entryId: string }>;
	}>
	| Readonly<{
		disposition: "not_observed";
		messageId: string;
		inspectedThrough: Readonly<{ agentId: string; entryId: string }>;
	}>
	| Readonly<{
		disposition: "indeterminate";
		messageId: string;
		reason: "inspection_incomplete";
	}>;

export type AgentMessageRetryReceipt =
	| Readonly<{
		disposition: "delivered";
		messageId: string;
		deliveryEvidence: Readonly<{ agentId: string; entryId: string }>;
	}>
	| Readonly<{
		disposition: "pending";
		messageId: string;
	}>
	| Readonly<{
		disposition: "rejected";
		messageId: string;
		rejectionReason:
			| "target_unavailable"
			| "host_shutting_down"
			| "evidence_unavailable"
			| "policy_rejected"
			| "capacity_exhausted";
	}>
	| Readonly<{
		disposition: "indeterminate";
		messageId: string;
		reason: "confirmation_lost" | "inspection_incomplete";
	}>;

export type AgentRequestRetryReceipt =
	| Readonly<{
		disposition: "answer_delivered";
		messageId: string;
		requestId: string;
		answerId: string;
		fromAgentId: string;
		answer: string;
		answerSource: ToolCallPointer;
	}>
	| Readonly<{
		disposition: "answer_already_delivered";
		messageId: string;
		requestId: string;
		answerId: string;
		deliveryEvidence: Readonly<{ agentId: string; entryId: string }>;
	}>
	| Readonly<{
		disposition: "request_delivered";
		messageId: string;
		requestId: string;
		deliveryEvidence: Readonly<{ agentId: string; entryId: string }>;
	}>
	| Readonly<{
		disposition: "request_pending";
		messageId: string;
		requestId: string;
	}>;

export type AgentMessageReceipt =
	| AgentMessageSendReceipt
	| AgentRequestReceipt
	| AgentAnswerReceipt
	| RequestCancellationReceipt
	| AgentMessagePollReceipt
	| AgentMessageRetryReceipt
	| AgentRequestRetryReceipt;
