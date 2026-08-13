import type {
	AgentToolResult,
	Theme,
	ThemeColor,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type {
	AgentMessageInput,
	AgentMessageReceipt,
} from "../coordination/workflow-coordinator.ts";
import { boundedToolPreview } from "./bounded-preview.ts";

export function renderAgentMessageCall(
	args: AgentMessageInput,
	theme: Theme,
): Text {
	let text = theme.fg("toolTitle", theme.bold("message "));
	if (args.operation === "send") {
		text += theme.fg("accent", args.targetAgentId);
		if (args.deliveryMode === "steer") {
			text += theme.fg("warning", " · steer");
		}
		text += theme.fg("dim", ` · ${boundedToolPreview(args.content)}`);
		return new Text(text, 0, 0);
	}
	if (args.operation === "request") {
		text += theme.fg("accent", args.targetAgentId);
		if (args.deliveryMode === "steer") {
			text += theme.fg("warning", " · steer");
		}
		text += theme.fg("dim", ` · ${boundedToolPreview(args.question)}`);
		return new Text(text, 0, 0);
	}
	if (args.operation === "answer") {
		text += theme.fg("accent", "answer");
		text += theme.fg("dim", ` · ${args.requestId} · ${boundedToolPreview(args.answer)}`);
		return new Text(text, 0, 0);
	}
	if (args.operation === "cancel") {
		text += theme.fg("accent", "cancel");
		text += theme.fg(
			"dim",
			` · ${args.requestMessageId} · ${boundedToolPreview(args.reason)}`,
		);
		return new Text(text, 0, 0);
	}
	text += theme.fg("accent", args.operation);
	text += theme.fg("dim", ` · ${args.messageId}`);
	return new Text(text, 0, 0);
}

export function renderAgentMessageResult(
	result: AgentToolResult<AgentMessageReceipt>,
	options: ToolRenderResultOptions,
	theme: Theme,
): Text {
	if (options.isPartial) {
		return new Text(theme.fg("warning", "scheduling…"), 0, 0);
	}
	const receipt = result.details;
	const disposition = "delivery" in receipt
		? receipt.delivery
		: receipt.disposition;
	let text = theme.fg(dispositionColor(disposition), disposition);
	if ("messageId" in receipt) {
		text += theme.fg("dim", ` · ${receipt.messageId}`);
	} else if ("answerMessageId" in receipt) {
		text += theme.fg("dim", ` · ${receipt.answerMessageId}`);
	} else {
		text += theme.fg("dim", ` · ${receipt.cancellationMessageId}`);
	}
	if (
		"disposition" in receipt &&
		receipt.disposition === "answer_delivered"
	) {
		text += theme.fg(
			"dim",
			` · ${receipt.answerId} · ${boundedToolPreview(receipt.answer)}`,
		);
	}
	if ("rejectionReason" in receipt) {
		text += theme.fg("error", ` · ${receipt.rejectionReason}`);
	} else if ("reason" in receipt) {
		text += theme.fg("warning", ` · ${receipt.reason}`);
	}
	if (options.expanded) {
		if ("deliveryEvidence" in receipt) {
			text += theme.fg(
				"dim",
				`\nproof · ${receipt.deliveryEvidence.agentId}:${receipt.deliveryEvidence.entryId}`,
			);
		} else if ("inspectedThrough" in receipt) {
			text += theme.fg(
				"dim",
				`\ninspected · ${receipt.inspectedThrough.agentId}:${receipt.inspectedThrough.entryId}`,
			);
		}
	}
	return new Text(text, 0, 0);
}

function dispositionColor(disposition: string): ThemeColor {
	switch (disposition) {
		case "delivered":
		case "answer_delivered":
		case "answer_already_delivered":
		case "request_delivered":
		case "already_answered":
		case "already_cancelled":
			return "success";
		case "rejected":
			return "error";
		case "pending":
		case "indeterminate":
			return "warning";
		default:
			return "muted";
	}
}
