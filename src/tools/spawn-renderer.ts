import type {
	AgentToolResult,
	Theme,
	ThemeColor,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type {
	AgentSpawnInput,
	AgentSpawnReceipt,
} from "../coordination/workflow-coordinator.ts";
import { boundedToolPreview } from "./bounded-preview.ts";

const SHORT_ID_CODE_POINTS = 12;

export function renderAgentSpawnCall(args: AgentSpawnInput, theme: Theme): Text {
	const label = args.label ?? args.template ?? "agent";
	const detail = args.description ?? args.request;
	let text = theme.fg("toolTitle", theme.bold("spawn "));
	text += theme.fg("accent", label);
	text += theme.fg("dim", ` · ${boundedToolPreview(detail)}`);
	return new Text(text, 0, 0);
}

export function renderAgentSpawnResult(
	result: AgentToolResult<AgentSpawnReceipt>,
	options: ToolRenderResultOptions,
	theme: Theme,
): Text {
	if (options.isPartial || result.details === undefined) {
		return new Text(theme.fg("warning", "resolving configuration…"), 0, 0);
	}
	const receipt = result.details;
	let text = theme.fg(spawnStatusColor(receipt.spawnStatus), receipt.spawnStatus);
	if ("messageStatus" in receipt) {
		text += theme.fg(
			receipt.messageStatus === "sent" ? "success" : "warning",
			` · ${receipt.messageStatus}`,
		);
	}
	if ("agentId" in receipt && receipt.agentId !== undefined) {
		text += theme.fg("dim", ` · ${shortIdentity(receipt.agentId)}`);
	} else if (
		"candidateAgentId" in receipt &&
		receipt.candidateAgentId !== undefined
	) {
		text += theme.fg("dim", ` · ${shortIdentity(receipt.candidateAgentId)}`);
	}
	const configuration = "effectiveConfiguration" in receipt
		? receipt.effectiveConfiguration
		: undefined;
	if (configuration) {
		text += theme.fg(
			"dim",
			` · ${configuration.model.provider}/${configuration.model.modelId} · ${configuration.thinking}`,
		);
	}
	if ("failedStage" in receipt) {
		text += theme.fg("warning", ` · ${receipt.failedStage}`);
	}
	if (options.expanded) {
		text += theme.fg("dim", `\n${JSON.stringify(receipt, null, 2)}`);
	}
	return new Text(text, 0, 0);
}

function shortIdentity(agentId: string): string {
	const codePoints = [...agentId];
	return codePoints.length <= SHORT_ID_CODE_POINTS
		? agentId
		: `${codePoints.slice(0, SHORT_ID_CODE_POINTS).join("")}…`;
}

function spawnStatusColor(status: AgentSpawnReceipt["spawnStatus"]): ThemeColor {
	switch (status) {
		case "created":
			return "success";
		case "not_created":
			return "error";
		case "unknown":
			return "warning";
	}
}
