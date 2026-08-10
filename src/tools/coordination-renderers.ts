import {
	getMarkdownTheme,
	type AgentToolResult,
	type Theme,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
	Box,
	Container,
	Markdown,
	Spacer,
	Text,
	type Component,
} from "@earendil-works/pi-tui";

import type { HumanRequestInput, HumanAnswer } from "../protocol/human-request.ts";
import type {
	ModeratorControlInput,
	ModeratorControlReceipt,
} from "../protocol/moderator-control.ts";
import type { RunControlInput, RunControlReceipt } from "../protocol/run-control.ts";
import { boundedToolPreview } from "./bounded-preview.ts";

type AgentObserveInput = Readonly<{
	operation: "status" | "children";
	agentId?: string;
}>;

export function renderAgentObserveCall(args: AgentObserveInput, theme: Theme): Text {
	return toolCall(theme, "observe", [args.operation, args.agentId]);
}

export function renderAgentObserveResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
): Text {
	if (options.isPartial) return pending(theme, "inspecting");
	const details = asRecord(result.details);
	const children = Array.isArray(details?.children) ? details.children : undefined;
	const summary = children
		? `${children.length} child${children.length === 1 ? "" : "ren"}`
		: typeof details?.agentId === "string"
			? details.agentId
			: "observed";
	return receipt(theme, summary, result.details, options);
}

export function renderAgentControlCall(args: RunControlInput, theme: Theme): Text {
	return toolCall(theme, "control", [
		args.operation,
		args.agentId,
		args.operation === "resume" ? boundedToolPreview(args.content) : undefined,
	]);
}

export function renderAgentControlResult(
	result: AgentToolResult<RunControlReceipt>,
	options: ToolRenderResultOptions,
	theme: Theme,
): Text {
	if (options.isPartial || result.details === undefined) return pending(theme, "controlling");
	const details = result.details;
	const disposition = "disposition" in details ? details.disposition : details.delivery;
	return receipt(theme, `${disposition} · ${details.agentId}`, details, options);
}

export function renderHumanRequestCall(
	args: HumanRequestInput,
	theme: Theme,
	context: Readonly<{ isPartial: boolean }>,
): Component {
	return transcriptBlock({
		label: context.isPartial ? "[Ask User]  waiting" : "[Ask User]",
		markdown: typeof args.question === "string" ? args.question : "",
		theme,
		background: "customMessageBg",
		textColor: "customMessageText",
	});
}

export function renderHumanRequestResult(
	result: AgentToolResult<HumanAnswer>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: Readonly<{ isError: boolean }>,
): Component {
	if (options.isPartial) return new Container();
	if (context.isError) {
		return transcriptBlock({
			label: "[Interrupted]",
			markdown: toolResultText(result),
			theme,
			background: "toolErrorBg",
			textColor: "error",
		});
	}
	return transcriptBlock({
		label: "[Answer]",
		markdown: result.details?.answer ?? toolResultText(result),
		theme,
		background: "userMessageBg",
		textColor: "userMessageText",
	});
}

export function renderModeratorControlCall(
	args: ModeratorControlInput,
	theme: Theme,
): Text {
	return args.operation === "renew_review_deadline"
		? toolCall(theme, "moderate", [
			"renew review",
			args.toolCall.toolCallId,
			`${args.nextReviewInMs} ms`,
		])
		: toolCall(theme, "moderate", ["resolve", boundedToolPreview(args.summary)]);
}

export function renderModeratorControlResult(
	result: AgentToolResult<ModeratorControlReceipt>,
	options: ToolRenderResultOptions,
	theme: Theme,
): Text {
	if (options.isPartial || result.details === undefined) return pending(theme, "moderating");
	return receipt(theme, result.details.disposition, result.details, options);
}

function toolCall(
	theme: Theme,
	label: string,
	details: readonly (string | undefined)[],
): Text {
	let text = theme.fg("toolTitle", theme.bold(`${label} `));
	text += details
		.filter((detail): detail is string => detail !== undefined && detail.length > 0)
		.map((detail, index) => theme.fg(index === 0 ? "accent" : "dim", detail))
		.join(theme.fg("dim", " · "));
	return new Text(text, 0, 0);
}

function pending(theme: Theme, label: string): Text {
	return new Text(theme.fg("warning", `${label}…`), 0, 0);
}

function receipt(
	theme: Theme,
	summary: string,
	details: unknown,
	options: ToolRenderResultOptions,
): Text {
	let text = theme.fg("success", summary);
	if (options.expanded) text += theme.fg("dim", `\n${JSON.stringify(details, null, 2)}`);
	return new Text(text, 0, 0);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null
		? value as Record<string, unknown>
		: undefined;
}

function transcriptBlock(options: {
	label: string;
	markdown: string;
	theme: Theme;
	background: "customMessageBg" | "toolErrorBg" | "userMessageBg";
	textColor: "customMessageText" | "error" | "userMessageText";
}): Component {
	const box = new Box(
		1,
		1,
		(content) => options.theme.bg(options.background, content),
	);
	box.addChild(new Text(
		options.theme.fg(options.textColor, options.theme.bold(options.label)),
		0,
		0,
	));
	box.addChild(new Spacer(1));
	box.addChild(new Markdown(
		options.markdown,
		0,
		0,
		getMarkdownTheme(),
		{ color: (content) => options.theme.fg(options.textColor, content) },
		{ preserveOrderedListMarkers: true, preserveBackslashEscapes: true },
	));
	return box;
}

function toolResultText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map(({ text }) => text)
		.join("\n");
}
