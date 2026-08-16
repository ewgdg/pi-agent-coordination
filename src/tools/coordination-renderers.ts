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

import type { AgentStatus } from "../coordination/agent-record.ts";
import type {
	AgentWaitInput,
	AgentWaitProgress,
	AgentWaitResult,
} from "../protocol/agent-wait.ts";
import {
	formatAgentIdentity,
	formatKnownAgentIdentity,
	type AgentLabelResolver,
} from "../presentation/agent-identity.ts";
import {
	formatAgentWorkStatus,
	selectedAgentWorkStatus,
} from "../presentation/selected-agent-status.ts";
import type { HumanRequestInput, HumanAnswer } from "../protocol/human-request.ts";
import type {
	ModeratorControlInput,
	ModeratorControlReceipt,
} from "../protocol/moderator-control.ts";
import type { RunControlInput, RunControlReceipt } from "../protocol/run-control.ts";
import type { AgentRunState } from "../runtime/agent-runtime-host.ts";
import { boundedToolPreview } from "./bounded-preview.ts";
import { renderMessageProjection } from "./message-delivery-renderer.ts";

type AgentObserveInput = Readonly<{
	operation: "status" | "children";
	agentId?: string;
}>;

export function renderAgentWaitCall(
	_args: AgentWaitInput,
	theme: Theme,
): Text {
	return toolCall(theme, "wait", []);
}

export function renderAgentWaitResult(
	result: AgentToolResult<AgentWaitResult | AgentWaitProgress>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: Readonly<{ state: AgentWaitRenderState }>,
	resolveAgentLabel: AgentLabelResolver = () => undefined,
): Component {
	if (options.isPartial) {
		if (isAgentWaitProgress(result.details)) {
			context.state.progress = result.details;
			const count = result.details.waitingFor.length;
			const identities = result.details.waitingFor.map(({ responderAgentId }) =>
				theme.fg(
					"accent",
					formatAgentIdentity(responderAgentId, resolveAgentLabel),
				)
			);
			return new Text([
				theme.fg("warning", `waiting for ${count} Answer${count === 1 ? "" : "s"}…`),
				...identities.map((identity) => `• ${identity}`),
			].join("\n"), 0, 0);
		}
		return pending(theme, "waiting for Answers");
	}
	if (result.details && "disposition" in result.details) {
		return receipt(theme, "preempted", result.details, options);
	}
	if (!result.details || !("answers" in result.details)) {
		return receipt(theme, "0 Answers", result.details, options);
	}
	const count = result.details.answers.length;
	const progressByRequest = new Map<string, string>(
		context.state.progress?.waitingFor.map((waiting): [string, string] => [
			waiting.requestMessageId,
			waiting.responderAgentId,
		]) ?? [],
	);
	const container = new Container();
	container.addChild(new Text(
		theme.fg("success", `${count} Answer${count === 1 ? "" : "s"}`),
		0,
		0,
	));
	for (const answer of result.details.answers) {
		container.addChild(new Spacer(1));
		if (answer.disposition === "answer_delivered") {
			container.addChild(renderMessageProjection(
				{
					kind: "answer",
					answerId: answer.answerId,
					requestMessageId: answer.requestMessageId,
					fromAgentId: answer.fromAgentId,
					answer: answer.answer,
				},
				options,
				theme,
				resolveAgentLabel,
			));
			continue;
		}
		const responderAgentId = progressByRequest.get(answer.requestMessageId);
		const identity = responderAgentId
			? ` from ${formatAgentIdentity(
				responderAgentId,
				resolveAgentLabel,
				options.expanded ? "full" : "compact",
			)}`
			: "";
		container.addChild(new Text(
			`${theme.fg("customMessageLabel", theme.bold("[Answer already delivered]"))}${
				theme.fg("muted", identity)
			}`,
			0,
			0,
		));
	}
	if (options.expanded) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(
			theme.fg("dim", JSON.stringify(result.details, null, 2)),
			0,
			0,
		));
	}
	return container;
}

type AgentWaitRenderState = { progress?: AgentWaitProgress };

function isAgentWaitProgress(value: unknown): value is AgentWaitProgress {
	return typeof value === "object" && value !== null &&
		"waitingFor" in value && Array.isArray(value.waitingFor);
}

export function renderAgentObserveCall(
	args: AgentObserveInput,
	theme: Theme,
	resolveAgentLabel: AgentLabelResolver = () => undefined,
): Text {
	return toolCall(theme, "observe", [
		args.operation,
		args.agentId
			? formatAgentIdentity(args.agentId, resolveAgentLabel)
			: undefined,
	]);
}

export function renderAgentObserveResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	_context: Readonly<{ args: AgentObserveInput }>,
): Text {
	if (options.isPartial) return pending(theme, "inspecting");
	const details = asRecord(result.details);
	const children = Array.isArray(details?.children) ? details.children : undefined;
	if (children) {
		return receipt(
			theme,
			`${children.length} child${children.length === 1 ? "" : "ren"}`,
			result.details,
			options,
		);
	}
	const status = observedAgentStatus(details);
	return status
		? agentStatusReceipt(theme, status, result.details, options)
		: receipt(theme, "observed", result.details, options);
}

export function renderAgentControlCall(
	args: RunControlInput,
	theme: Theme,
	resolveAgentLabel: AgentLabelResolver = () => undefined,
): Text {
	return toolCall(theme, "control", [
		args.operation,
		formatAgentIdentity(args.agentId, resolveAgentLabel),
		args.operation === "resume" ? boundedToolPreview(args.content) : undefined,
	]);
}

export function renderAgentControlResult(
	result: AgentToolResult<RunControlReceipt>,
	options: ToolRenderResultOptions,
	theme: Theme,
	resolveAgentLabel: AgentLabelResolver = () => undefined,
): Text {
	if (options.isPartial || result.details === undefined) return pending(theme, "controlling");
	const details = result.details;
	const disposition = "disposition" in details ? details.disposition : details.delivery;
	return receipt(
		theme,
		`${disposition} · ${formatAgentIdentity(
			details.agentId,
			resolveAgentLabel,
			options.expanded ? "full" : "compact",
		)}`,
		details,
		options,
	);
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

function agentStatusReceipt(
	theme: Theme,
	status: Pick<AgentStatus, "agentId" | "label" | "run">,
	details: unknown,
	options: ToolRenderResultOptions,
): Text {
	const identity = theme.fg(
		"toolTitle",
		theme.bold(formatKnownAgentIdentity(
			status.agentId,
			status.label,
			options.expanded ? "full" : "compact",
		)),
	);
	const workStatus = formatAgentWorkStatus(
		selectedAgentWorkStatus(status.run, false),
		theme,
	);
	let text = `${identity}\n${workStatus}`;
	if (options.expanded) text += theme.fg("dim", `\n${JSON.stringify(details, null, 2)}`);
	return new Text(text, 0, 0);
}

function observedAgentStatus(
	value: Record<string, unknown> | undefined,
): Pick<AgentStatus, "agentId" | "label" | "run"> | undefined {
	if (
		typeof value?.agentId !== "string" ||
		typeof value.label !== "string" ||
		!isAgentRunState(value.run)
	) return undefined;
	return {
		agentId: value.agentId,
		label: value.label,
		run: value.run,
	};
}

function isAgentRunState(value: unknown): value is AgentRunState {
	const run = asRecord(value);
	if (!run || !Array.isArray(run.retentionReasons)) return false;
	if (run.phase === "dormant") return true;
	return (
		(run.phase === "starting" || run.phase === "live" || run.phase === "ending") &&
		(run.work === undefined || run.work === "active" || run.work === "settled") &&
		(
			run.attention === "none" ||
			run.attention === "input_required" ||
			run.attention === "agent_wait"
		)
	);
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
