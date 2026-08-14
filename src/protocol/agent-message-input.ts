export type MessageDeliveryMode = "deferred" | "steer";

export type MessageSendInput = Readonly<{
	operation: "send";
	targetAgentId: string;
	content: string;
	deliveryMode?: MessageDeliveryMode;
}>;

export type RequestSendInput = Readonly<{
	operation: "request";
	targetAgentId: string;
	question: string;
	deliveryMode?: MessageDeliveryMode;
}>;

export type MessagePollInput = Readonly<{
	operation: "poll";
	messageId: string;
}>;

export type MessageRetryInput = Readonly<{
	operation: "retry";
	messageId: string;
}>;

export type AnswerInput = Readonly<{
	operation: "answer";
	requestMessageId: string;
	answer: string;
}>;

export type CancellationInput = Readonly<{
	operation: "cancel";
	requestMessageId: string;
	reason: string;
}>;

export type AgentMessageInput =
	| MessageSendInput
	| RequestSendInput
	| AnswerInput
	| CancellationInput
	| MessagePollInput
	| MessageRetryInput;

export function sameAgentMessageInput(
	left: AgentMessageInput,
	right: AgentMessageInput,
): boolean {
	switch (left.operation) {
		case "send":
			return right.operation === "send" &&
				left.targetAgentId === right.targetAgentId &&
				left.content === right.content &&
				(left.deliveryMode ?? "deferred") ===
					(right.deliveryMode ?? "deferred");
		case "request":
			return right.operation === "request" &&
				left.targetAgentId === right.targetAgentId &&
				left.question === right.question &&
				(left.deliveryMode ?? "deferred") ===
					(right.deliveryMode ?? "deferred");
		case "answer":
			return right.operation === "answer" &&
				left.requestMessageId === right.requestMessageId &&
				left.answer === right.answer;
		case "cancel":
			return right.operation === "cancel" &&
				left.requestMessageId === right.requestMessageId &&
				left.reason === right.reason;
		case "poll":
			return right.operation === "poll" && left.messageId === right.messageId;
		case "retry":
			return right.operation === "retry" && left.messageId === right.messageId;
	}
}

export function validateAgentMessageInput(
	value: Record<string, unknown>,
): AgentMessageInput {
	if (value.operation === "send") return validateMessageSendInput(value);
	if (value.operation === "request") return validateRequestSendInput(value);
	if (value.operation === "answer") {
		const keys = Object.keys(value).sort();
		if (!sameStringList(keys, ["answer", "operation", "requestMessageId"])) {
			throw new Error("invalid_input: Agent Answer input has an invalid shape");
		}
		if (
			typeof value.requestMessageId !== "string" ||
			value.requestMessageId.length === 0
		) {
			throw new Error(
				"invalid_input: Agent Answer requestMessageId must not be empty",
			);
		}
		if (typeof value.answer !== "string" || value.answer.length === 0) {
			throw new Error("invalid_input: Agent Answer answer must not be empty");
		}
		return {
			operation: "answer",
			requestMessageId: value.requestMessageId,
			answer: value.answer,
		};
	}
	if (value.operation === "cancel") {
		const keys = Object.keys(value).sort();
		if (!sameStringList(keys, ["operation", "reason", "requestMessageId"])) {
			throw new Error("invalid_input: Request Cancellation input has an invalid shape");
		}
		if (
			typeof value.requestMessageId !== "string" ||
			value.requestMessageId.length === 0
		) {
			throw new Error(
				"invalid_input: Request Cancellation requestMessageId must not be empty",
			);
		}
		if (typeof value.reason !== "string" || value.reason.length === 0) {
			throw new Error("invalid_input: Request Cancellation reason must not be empty");
		}
		return {
			operation: "cancel",
			requestMessageId: value.requestMessageId,
			reason: value.reason,
		};
	}
	const keys = Object.keys(value).sort();
	if (!sameStringList(keys, ["messageId", "operation"])) {
		throw new Error("invalid_input: Agent Message poll input has an invalid shape");
	}
	if (value.operation !== "poll" && value.operation !== "retry") {
		throw new Error("invalid_input: Agent Message operation is unavailable");
	}
	if (typeof value.messageId !== "string" || value.messageId.length === 0) {
		throw new Error("invalid_input: Agent Message messageId must not be empty");
	}
	return { operation: value.operation, messageId: value.messageId };
}

function validateRequestSendInput(value: Record<string, unknown>): RequestSendInput {
	const keys = Object.keys(value).sort();
	const expectedKeys = value.deliveryMode === undefined
		? ["operation", "question", "targetAgentId"]
		: ["deliveryMode", "operation", "question", "targetAgentId"];
	if (!sameStringList(keys, expectedKeys)) {
		throw new Error("invalid_input: Agent Request input has an invalid shape");
	}
	if (typeof value.targetAgentId !== "string" || value.targetAgentId.length === 0) {
		throw new Error("invalid_input: Agent Request targetAgentId must not be empty");
	}
	if (typeof value.question !== "string" || value.question.length === 0) {
		throw new Error("invalid_input: Agent Request question must not be empty");
	}
	if (
		value.deliveryMode !== undefined &&
		value.deliveryMode !== "deferred" &&
		value.deliveryMode !== "steer"
	) {
		throw new Error("invalid_input: Agent Request deliveryMode is unavailable");
	}
	return {
		operation: "request",
		targetAgentId: value.targetAgentId,
		question: value.question,
		...(value.deliveryMode === undefined
			? {}
			: { deliveryMode: value.deliveryMode }),
	};
}

function validateMessageSendInput(
	value: Record<string, unknown>,
): MessageSendInput {
	const keys = Object.keys(value).sort();
	const expectedKeys = value.deliveryMode === undefined
		? ["content", "operation", "targetAgentId"]
		: ["content", "deliveryMode", "operation", "targetAgentId"];
	if (!sameStringList(keys, expectedKeys)) {
		throw new Error("invalid_input: Agent Message send input has an invalid shape");
	}
	if (typeof value.targetAgentId !== "string" || value.targetAgentId.length === 0) {
		throw new Error("invalid_input: Agent Message targetAgentId must not be empty");
	}
	if (typeof value.content !== "string" || value.content.length === 0) {
		throw new Error("invalid_input: Agent Message content must not be empty");
	}
	if (
		value.deliveryMode !== undefined &&
		value.deliveryMode !== "deferred" &&
		value.deliveryMode !== "steer"
	) {
		throw new Error("invalid_input: Agent Message deliveryMode is unavailable");
	}
	return {
		operation: "send",
		targetAgentId: value.targetAgentId,
		content: value.content,
		...(value.deliveryMode === undefined
			? {}
			: { deliveryMode: value.deliveryMode }),
	};
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}
