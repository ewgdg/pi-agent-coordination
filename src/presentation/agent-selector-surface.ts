import type {
	ExtensionUIContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Key,
	SelectList,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type SelectItem,
	type SelectListTheme,
	type TUI,
} from "@earendil-works/pi-tui";

import type { AgentRosterStatus } from "../coordination/workflow-coordinator.ts";
import type { HumanAttentionItem } from "../coordination/human-requests.ts";
import type { OperationalIncidentAttention } from "../coordination/operational-incidents.ts";
import {
	formatOperationalIncidentHeadline,
	operationalIncidentRequestEvidence,
} from "./operational-incident-surface.ts";

const AGENT_SELECTOR_OVERLAY_WIDTH = 80;
const AGENT_SELECTOR_OVERLAY_MARGIN = 1;
const AGENT_SELECTOR_OVERLAY_MAX_HEIGHT_PERCENT = 90;
const MAX_VISIBLE_ROSTER_ROWS = 10;
const MAX_BREADCRUMB_AGENT_SEGMENTS = 3;
const FOCUSED_DETAIL_ROWS = 4;
const FRAME_ROWS = 2;
const TAB_ROWS = 1;
const CONTENT_GAP_ROWS = 2;
const HELP_ROWS = 1;
const MAX_LIVE_SECTION_HEADER_ROWS = 3;
const FIXED_OVERLAY_ROWS =
	FRAME_ROWS + TAB_ROWS + CONTENT_GAP_ROWS + HELP_ROWS +
	MAX_LIVE_SECTION_HEADER_ROWS + FOCUSED_DETAIL_ROWS;
const SCROLL_INDICATOR_ROWS = 1;
const SELECT_LIST_UP_INPUT = "\x1b[A";
const SELECT_LIST_DOWN_INPUT = "\x1b[B";

export type AgentSelectorAction =
	| Readonly<{
		kind: "select_agent";
		agentId: string;
	}>
	| Readonly<{
		kind: "focus_human_request";
		requestId: string;
	}>;

export type AgentSelectorOptions = Readonly<{
	live: readonly AgentRosterStatus[];
	dormant: readonly AgentRosterStatus[];
	selectedAgentId: string;
	humanAttention?: readonly HumanAttentionItem[];
	operationalAttention?: readonly OperationalIncidentAttention[];
}>;

type AgentSelectorItem = SelectItem & Readonly<{
	status?: AgentRosterStatus;
	kind: "decide" | "attention" | "owner" | "agent";
	action?: AgentSelectorAction;
	detailLines?: readonly string[];
}>;

export function openAgentSelectorSurface(
	ui: ExtensionUIContext,
	options: AgentSelectorOptions,
): Promise<AgentSelectorAction | undefined> {
	return ui.custom<AgentSelectorAction | undefined>(
		(tui, theme, _keybindings, done) =>
			new AgentSelectorSurface(tui, theme, options, done),
		{
			overlay: true,
			overlayOptions: {
			width: AGENT_SELECTOR_OVERLAY_WIDTH,
			maxHeight: `${AGENT_SELECTOR_OVERLAY_MAX_HEIGHT_PERCENT}%`,
				anchor: "center",
				margin: AGENT_SELECTOR_OVERLAY_MARGIN,
			},
		},
	);
}

class AgentSelectorSurface implements Component {
	readonly #tui: TUI;
	readonly #theme: Theme;
	readonly #done: (result: AgentSelectorAction | undefined) => void;
	readonly #options: AgentSelectorOptions;
	#activeTab: "live" | "dormant" = "live";
	#scopeAgentId: string;
	#selectedValueByTab: { live: string; dormant?: string };
	#items: AgentSelectorItem[] = [];
	#selectedIndex = 0;
	#visibleRows = 1;
	#list: SelectList;

	constructor(
		tui: TUI,
		theme: Theme,
		options: AgentSelectorOptions,
		done: (result: AgentSelectorAction | undefined) => void,
	) {
		this.#tui = tui;
		this.#theme = theme;
		this.#done = done;
		this.#options = options;
		const owner = this.#ownerStatus();
		const selected = options.live.find(
			({ agentId }) => agentId === options.selectedAgentId,
		);
		this.#scopeAgentId = selected?.agentId === owner.agentId
			? owner.agentId
			: selected?.directSpawnerAgentId ?? owner.agentId;
		this.#selectedValueByTab = {
			live: this.#attentionItems()[0]?.value ?? selected?.agentId ?? owner.agentId,
			dormant: options.dormant[0]?.agentId,
		};
		this.#list = this.#createList();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.#done(undefined);
			return;
		}
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
			this.#activeTab = this.#activeTab === "live" ? "dormant" : "live";
			this.#list = this.#createList();
			this.#tui.requestRender();
			return;
		}
		if (this.#activeTab === "live" && (matchesKey(data, Key.right) || matchesKey(data, "l"))) {
			this.#zoomIn();
			this.#tui.requestRender();
			return;
		}
		if (this.#activeTab === "live" && (matchesKey(data, Key.left) || matchesKey(data, "h"))) {
			this.#zoomOut();
			this.#tui.requestRender();
			return;
		}
		const listInput = matchesKey(data, "j")
			? SELECT_LIST_DOWN_INPUT
			: matchesKey(data, "k")
				? SELECT_LIST_UP_INPUT
				: data;
		this.#list.handleInput(listInput);
		this.#tui.requestRender();
	}

	invalidate(): void {
		this.#list.invalidate();
	}

	render(width: number): string[] {
		const frameWidth = Math.min(width, AGENT_SELECTOR_OVERLAY_WIDTH);
		const innerWidth = Math.max(1, frameWidth - 2);
		const contentWidth = Math.max(1, innerWidth - 2);
		const border = (text: string) => this.#theme.fg("border", text);
		const contentLines = [
			this.#renderTabs(),
			"",
			...(this.#activeTab === "live"
				? this.#renderSectionedLiveList(contentWidth)
				: [
					this.#theme.fg("toolTitle", this.#theme.bold("Dormant Agents")),
					...this.#renderDormantList(contentWidth),
				]),
			"",
			this.#theme.fg(
				"dim",
				"Tab views · ↑/k ↓/j · →/l children · ←/h parent · Enter · Esc",
			),
		];
		const visibleContentLines = fitOverlayContent(
			contentLines,
			Math.max(0, this.#maximumOverlayRows() - FRAME_ROWS),
		);
		const blockWidth = Math.min(
			contentWidth,
			Math.max(1, ...visibleContentLines.map((line) => visibleWidth(line))),
		);
		const leftMargin = Math.floor((innerWidth - blockWidth) / 2);
		const rightMargin = innerWidth - blockWidth - leftMargin;
		return [
			border(`┌${"─".repeat(innerWidth)}┐`),
			...visibleContentLines.map((line) =>
				frameLine(line, blockWidth, leftMargin, rightMargin, border)
			),
			border(`└${"─".repeat(innerWidth)}┘`),
		];
	}

	#createList(): SelectList {
		this.#items = this.#activeTab === "live"
			? this.#liveItems()
			: this.#options.dormant.map((status) => this.#agentItem(status));
		this.#visibleRows = Math.max(
			1,
			Math.min(
				this.#items.length,
				MAX_VISIBLE_ROSTER_ROWS,
				this.#maximumOverlayRows() -
					FIXED_OVERLAY_ROWS - SCROLL_INDICATOR_ROWS,
			),
		);
		const list = new SelectList(
			this.#items,
			this.#visibleRows,
			this.#selectListTheme(),
		);
		const preferredValue = this.#selectedValueByTab[this.#activeTab];
		this.#selectedIndex = Math.max(
			0,
			this.#items.findIndex(({ value }) => value === preferredValue),
		);
		list.setSelectedIndex(this.#selectedIndex);
		list.onSelectionChange = (selected) => {
			const index = this.#items.indexOf(selected as AgentSelectorItem);
			if (index < 0) return;
			this.#selectedIndex = index;
			this.#selectedValueByTab[this.#activeTab] = selected.value;
		};
		list.onSelect = ({ value }) => {
			const selected = this.#items.find((item) => item.value === value);
			if (!selected || selected.kind === "attention") return;
			this.#done(selected.action ?? {
				kind: "select_agent",
				agentId: value,
			});
		};
		list.onCancel = () => this.#done(undefined);
		return list;
	}

	#maximumOverlayRows(): number {
		const terminalRows = this.#tui.terminal.rows;
		const percentBound = Math.floor(
			terminalRows * AGENT_SELECTOR_OVERLAY_MAX_HEIGHT_PERCENT / 100,
		);
		const marginBound = terminalRows - AGENT_SELECTOR_OVERLAY_MARGIN * 2;
		return Math.max(2, Math.min(percentBound, marginBound));
	}

	#liveItems(): AgentSelectorItem[] {
		const owner = this.#ownerStatus();
		return [
			...this.#attentionItems(),
			this.#agentItem(owner, "owner"),
			...this.#options.live
				.filter((status) =>
					status.directSpawnerAgentId === this.#scopeAgentId &&
					status.agentId !== owner.agentId
				)
				.map((status) => this.#agentItem(status)),
		];
	}

	#attentionItems(): AgentSelectorItem[] {
		const human = (this.#options.humanAttention ?? []).map((attention, index) => ({
			value: `human:${attention.requestId}`,
			label: `DECIDE ${index + 1} · ${attention.agentLabel}`,
			description: `${attention.questionCount} Question${attention.questionCount === 1 ? "" : "s"}`,
			kind: "decide" as const,
			action: {
				kind: "focus_human_request" as const,
				requestId: attention.requestId,
			},
			detailLines: [
				"",
				`Agent ${attention.agentId}`,
				`${attention.questionCount} Human Question${attention.questionCount === 1 ? "" : "s"}`,
				`Human Request ${attention.requestId}`,
			],
		}));
		const operational = (this.#options.operationalAttention ?? []).map(
			(attention, index) => {
				const requests = operationalIncidentRequestEvidence(attention);
				return {
					value: `operational:${index}`,
					label: `ATTENTION ${index + 1} · ${formatOperationalIncidentHeadline(attention)}`,
					description: `Requests ${requests.total}`,
					kind: "attention" as const,
					detailLines: [
						"",
						`Affected ${attention.affectedAgentIds.join(", ")}`,
						requests.sources.length === 0
							? `Requests ${requests.total}`
							: requests.sources.map(
								(pointer) =>
									`Request ${pointer.agentId}/${pointer.entryId}/${pointer.toolCallId}`,
							).join(" · "),
						attention.diagnostics.length === 0
							? ""
							: attention.diagnostics.map(
								(pointer) => `Diagnostic ${pointer.agentId}/${pointer.entryId}`,
							).join(" · "),
					],
				};
			},
		);
		return [...human, ...operational];
	}

	#agentItem(
		status: AgentRosterStatus,
		kind: "owner" | "agent" = "agent",
	): AgentSelectorItem {
		const childCount = this.#options.live.filter(
			(candidate) => candidate.directSpawnerAgentId === status.agentId,
		).length;
		const children = childCount === 0
			? undefined
			: `${childCount} ${childCount === 1 ? "child" : "children"} ›`;
		const moderator = status.agentId !== status.workflowId &&
			status.directSpawnerAgentId === null;
		return {
			value: status.agentId,
			label: status.label,
			description: [
				formatRun(status),
				moderator ? "Moderator" : undefined,
				moderator && status.run.phase === "dormant" ? status.description : undefined,
				children,
			].filter(Boolean).join(" · "),
			status,
			kind,
		};
	}

	#ownerStatus(): AgentRosterStatus {
		const owner = this.#options.live.find(
			(status) => status.agentId === status.workflowId,
		);
		if (!owner) throw new Error("Agent selector roster has no live Owner");
		return owner;
	}

	#renderSectionedLiveList(width: number): string[] {
		return this.#renderVisibleList(
			width,
			(item, previous) => {
				const sectionKind = liveSectionKind(item);
				if (sectionKind === (previous ? liveSectionKind(previous) : undefined)) {
					return undefined;
				}
				return this.#theme.fg(
					"toolTitle",
					this.#theme.bold(
						sectionKind === "attention"
							? "Attention Inbox"
							: sectionKind === "owner"
								? "Owner"
								: this.#scopeTitle(width),
					),
				);
			},
			MAX_LIVE_SECTION_HEADER_ROWS,
		);
	}

	#renderDormantList(width: number): string[] {
		return this.#renderVisibleList(width);
	}

	#renderVisibleList(
		width: number,
		sectionHeading?: (
			item: AgentSelectorItem,
			previous: AgentSelectorItem | undefined,
		) => string | undefined,
		reservedSectionRows = 0,
	): string[] {
		const listLines = this.#list.render(width);
		if (this.#items.length === 0) return listLines;
		const startIndex = Math.max(
			0,
			Math.min(
				this.#selectedIndex - Math.floor(this.#visibleRows / 2),
				this.#items.length - this.#visibleRows,
			),
		);
		const endIndex = Math.min(startIndex + this.#visibleRows, this.#items.length);
		const itemLineCount = endIndex - startIndex;
		const rendered: string[] = [];
		let renderedSectionRows = 0;
		for (let offset = 0; offset < itemLineCount; offset += 1) {
			const item = this.#items[startIndex + offset];
			if (!item) continue;
			const previous = offset === 0
				? undefined
				: this.#items[startIndex + offset - 1];
			const heading = sectionHeading?.(item, previous);
			if (heading !== undefined) {
				rendered.push(heading);
				renderedSectionRows += 1;
			}
			rendered.push(listLines[offset] ?? "");
			if (startIndex + offset === this.#selectedIndex) {
				rendered.push(...this.#focusedDetailLines(item, width));
			}
		}
		return [
			...rendered,
			...Array.from(
				{ length: Math.max(0, reservedSectionRows - renderedSectionRows) },
				() => "",
			),
			...listLines.slice(itemLineCount),
		];
	}

	#focusedDetailLines(item: AgentSelectorItem, width: number): string[] {
		const { status } = item;
		if (!status) {
			return Array.from({ length: FOCUSED_DETAIL_ROWS }, (_, index) =>
				this.#theme.fg(
					index < 2 ? "muted" : "dim",
					truncateToWidth(`  ${item.detailLines?.[index] ?? ""}`, width, ""),
				)
			);
		}
		const description = status.description === undefined ? "" : `  ${status.description}`;
		return [
			this.#theme.fg("muted", truncateToWidth(description, width, "")),
			this.#theme.fg("muted", truncateToWidth(`  ${status.agentId}`, width, "")),
			this.#theme.fg("dim", truncateToWidth(`  ${formatDetailedRun(status)}`, width, "")),
			this.#theme.fg(
				"dim",
				truncateToWidth(
					`  ${status.model.provider}/${status.model.modelId} · thinking ${status.thinking} · ${status.queuedInputCount} queued`,
					width,
					"",
				),
			),
		];
	}

	#zoomIn(): void {
		const selected = this.#items[this.#selectedIndex];
		if (!selected?.status) return;
		const firstChild = this.#options.live.find(
			(status) => status.directSpawnerAgentId === selected.value,
		);
		if (!firstChild) return;
		this.#scopeAgentId = selected.value;
		this.#selectedValueByTab.live = firstChild.agentId;
		this.#list = this.#createList();
	}

	#zoomOut(): void {
		const owner = this.#ownerStatus();
		if (this.#scopeAgentId === owner.agentId) return;
		const previousScope = this.#scopeAgentId;
		const scope = [...this.#options.live, ...this.#options.dormant].find(
			({ agentId }) => agentId === previousScope,
		);
		this.#scopeAgentId = scope?.directSpawnerAgentId ?? owner.agentId;
		this.#selectedValueByTab.live = previousScope;
		this.#list = this.#createList();
	}

	#scopeTitle(width: number): string {
		const allStatuses = [...this.#options.live, ...this.#options.dormant];
		const owner = this.#ownerStatus();
		const labels: string[] = [];
		let current = allStatuses.find(({ agentId }) => agentId === this.#scopeAgentId);
		while (current && current.agentId !== owner.agentId) {
			labels.unshift(current.label);
			current = allStatuses.find(
				({ agentId }) => agentId === current?.directSpawnerAgentId,
			);
		}
		if (labels.length === 0) return "Agents";
		const visibleLabels = labels.slice(-MAX_BREADCRUMB_AGENT_SEGMENTS);
		const title = () =>
			`Agents / ${labels.length > visibleLabels.length ? "… / " : ""}${visibleLabels.join(" / ")}`;
		while (visibleLabels.length > 1 && visibleWidth(title()) > width) {
			visibleLabels.shift();
		}
		if (visibleWidth(title()) <= width) return title();
		const prefix = labels.length > 1 ? "… / " : "";
		return `${prefix}${truncateToWidth(
			visibleLabels.at(-1) ?? "",
			Math.max(1, width - visibleWidth(prefix)),
			"…",
		)}`;
	}

	#renderTabs(): string {
		const tab = (name: "Live" | "Dormant", active: boolean) =>
			active
				? this.#theme.bg("selectedBg", this.#theme.fg("text", ` ${name} `))
				: this.#theme.fg("muted", ` ${name} `);
		return `${tab("Live", this.#activeTab === "live")} ${tab(
			"Dormant",
			this.#activeTab === "dormant",
		)}`;
	}

	#selectListTheme(): SelectListTheme {
		return {
			selectedPrefix: (text) => this.#theme.fg("accent", text),
			selectedText: (text) => this.#theme.fg("accent", text),
			description: (text) => this.#theme.fg("dim", text),
			scrollInfo: (text) => this.#theme.fg("muted", text),
			noMatch: (text) => this.#theme.fg("muted", text),
		};
	}
}

function liveSectionKind(
	item: AgentSelectorItem,
): "attention" | "owner" | "agent" {
	return item.kind === "decide" || item.kind === "attention"
		? "attention"
		: item.kind;
}

function fitOverlayContent(lines: string[], maximumRows: number): string[] {
	const content = [...lines];
	while (content.length > maximumRows) {
		const emptyLine = content.findLastIndex((line) => visibleWidth(line) === 0);
		if (emptyLine < 0) break;
		content.splice(emptyLine, 1);
	}
	if (content.length > maximumRows) content.pop();
	return content.slice(0, maximumRows);
}

function frameLine(
	line: string,
	blockWidth: number,
	leftMargin: number,
	rightMargin: number,
	border: (text: string) => string,
): string {
	const content = truncateToWidth(line, blockWidth, "");
	const contentPadding = " ".repeat(Math.max(0, blockWidth - visibleWidth(content)));
	return `${border("│")}${" ".repeat(leftMargin)}${content}${contentPadding}${" ".repeat(rightMargin)}${border("│")}`;
}

function formatRun(status: AgentRosterStatus): string {
	const run = status.run;
	const work = "work" in run && run.work ? `/${run.work}` : "";
	return `${run.phase}${work}`;
}

function formatDetailedRun(status: AgentRosterStatus): string {
	const { run } = status;
	const state = run.phase === "dormant"
		? ["Dormant"]
		: [
			capitalize(run.phase),
			run.work,
			run.attention === "input_required" ? "input required" : undefined,
		];
	const retention = run.retentionReasons.length === 0
		? undefined
		: `Retention ${run.retentionReasons.map(({ reason, count }) => [
			reason.replaceAll("_", " "),
			count > 1 ? `×${count}` : undefined,
		].filter(Boolean).join(" ")).join(", ")}`;
	return [...state, retention].filter(Boolean).join(" · ");
}

function capitalize(value: string): string {
	return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}
