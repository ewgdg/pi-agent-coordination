import type {
	AgentToolResult,
	Theme,
	ThemeColor,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, type Component } from "@earendil-works/pi-tui";

import type {
	AgentMessageInput,
	AgentMessageReceipt,
} from "../coordination/workflow-coordinator.ts";
import {
	formatAgentIdentity,
	type AgentLabelResolver,
} from "../presentation/agent-identity.ts";
import { BodyPreview } from "../presentation/body-preview.ts";

export function renderAgentMessageCall(
	args: AgentMessageInput,
	theme: Theme,
	resolveAgentLabel: AgentLabelResolver = () => undefined,
	expanded = false,
): Component {
	const container = new Container();
	container.addChild(new Text(
		renderMessageCallHeader(args, theme, resolveAgentLabel),
		0,
		0,
	));
	const body = messageCallBody(args);
	if (body) {
		if (expanded) {
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(
				body,
				0,
				0,
				getMarkdownTheme(),
				{ color: (content) => theme.fg("customMessageText", content) },
				{ preserveOrderedListMarkers: true, preserveBackslashEscapes: true },
			));
		} else {
			container.addChild(new BodyPreview(
				body,
				(content) => theme.fg("customMessageText", content),
			));
		}
	}
	return container;
}

function renderMessageCallHeader(
	args: AgentMessageInput,
	theme: Theme,
	resolveAgentLabel: AgentLabelResolver,
): string {
	// Badge and body reuse the delivered-message theme roles (customMessageLabel /
	// customMessageText) so sent and delivered coordination content speak one visual
	// language, even though the tool frame background differs from customMsgBg.
	let text = theme.fg(
		"customMessageLabel",
		theme.bold(`[${messageCallOperationLabel(args.operation)}]`),
	);
	if (args.operation === "send" || args.operation === "request") {
		text += theme.fg(
			"muted",
			` to ${formatAgentIdentity(args.targetAgentId, resolveAgentLabel)}`,
		);
		if (args.deliveryMode === "steer") {
			text += theme.fg("warning", " · steer");
		}
	} else if (args.operation === "cancel") {
		text += theme.fg("dim", ` · ${args.requestMessageId}`);
	} else if (args.operation === "poll" || args.operation === "retry") {
		text += theme.fg("dim", ` · ${args.messageId}`);
	}
	return text;
}

function messageCallOperationLabel(operation: AgentMessageInput["operation"]): string {
	switch (operation) {
		case "send":
			return "Send";
		case "request":
			return "Request";
		case "answer":
			return "Answer";
		case "cancel":
			return "Cancel";
		case "poll":
			return "Poll";
		case "retry":
			return "Retry";
	}
}

function messageCallBody(args: AgentMessageInput): string | undefined {
	switch (args.operation) {
		case "send":
			return args.content;
		case "request":
			return args.question;
		case "answer":
			return args.answer;
		case "cancel":
			return args.reason;
		default:
			return undefined;
	}
}

export function renderAgentMessageResult(
	result: AgentToolResult<AgentMessageReceipt>,
	options: ToolRenderResultOptions,
	theme: Theme,
): Component {
	const container = new Container();
	if (options.isPartial) {
		container.addChild(new Text(theme.fg("warning", "scheduling…"), 0, 0));
		return container;
	}
	const receipt = result.details;
	const disposition = "messageStatus" in receipt
		? receipt.messageStatus
		: receipt.disposition;
	let text = theme.fg(dispositionColor(disposition), disposition);
	if ("messageId" in receipt) {
		text += theme.fg("dim", ` · ${receipt.messageId}`);
	} else if ("requestMessageId" in receipt) {
		text += theme.fg("dim", ` · ${receipt.requestMessageId}`);
	} else if ("answerMessageId" in receipt) {
		text += theme.fg("dim", ` · ${receipt.answerMessageId}`);
	} else {
		text += theme.fg("dim", ` · ${receipt.cancellationMessageId}`);
	}
	container.addChild(new Text(text, 0, 0));
	if (
		!options.expanded &&
		"disposition" in receipt &&
		receipt.disposition === "answer_delivered"
	) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(
			theme.fg("dim", `answer · ${receipt.answerId}`),
			0,
			0,
		));
		container.addChild(new BodyPreview(
			receipt.answer,
			(content) => theme.fg("customMessageText", content),
		));
	}
	if (!options.expanded && "reason" in receipt) {
		container.addChild(new Text(
			theme.fg(
				"messageStatus" in receipt && receipt.messageStatus === "not_sent"
					? "error"
					: "warning",
				receipt.reason,
			),
			0,
			0,
		));
	}
	if (options.expanded) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(
			theme.fg("dim", JSON.stringify(receipt, null, 2)),
			0,
			0,
		));
	}
	return container;
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
		case "sent":
			return "success";
		case "not_sent":
			return "error";
		case "unknown":
		case "indeterminate":
			return "warning";
		default:
			return "muted";
	}
}
