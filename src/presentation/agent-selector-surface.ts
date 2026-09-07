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
import { boundedToolPreview } from "../tools/bounded-preview.ts";
import {
	formatAgentWorkStatus,
	selectedAgentWorkStatus,
} from "./selected-agent-status.ts";

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
const MAX_LIVE_SECTION_HEADER_ROWS = 2;
const EMPTY_LIVE_AGENT_ROWS = 1;
const FIXED_OVERLAY_ROWS =
	FRAME_ROWS + TAB_ROWS + CONTENT_GAP_ROWS + HELP_ROWS +
	MAX_LIVE_SECTION_HEADER_ROWS + EMPTY_LIVE_AGENT_ROWS + FOCUSED_DETAIL_ROWS;
const SCROLL_INDICATOR_ROWS = 1;
const SELECT_LIST_UP_INPUT = "\x1b[A";
const SELECT_LIST_DOWN_INPUT = "\x1b[B";
const SELECTION_SPINNER_FRAMES = [
	"⠋",
	"⠙",
	"⠹",
	"⠸",
	"⠼",
	"⠴",
	"⠦",
	"⠧",
	"⠇",
	"⠏",
] as const;
const SELECTION_SPINNER_INTERVAL_MILLISECONDS = 80;

export type AgentSelectorAction =
	| Readonly<{
		kind: "select_agent";
		agentId: string;
	}>
	| Readonly<{
		kind: "decide";
		requestId: string;
		agentId: string;
	}>;

export type AgentSelectorOptions = Readonly<{
	live: readonly AgentRosterStatus[];
	dormant: readonly AgentRosterStatus[];
	selectedAgentId: string;
	addChangeHandler?(handler: (snapshot: Pick<AgentSelectorOptions, "live" | "dormant" | "humanAttention" | "operationalAttention">) => void): () => void;
	humanAttention?: readonly HumanAttentionItem[];
	operationalAttention?: readonly OperationalIncidentAttention[];
	prepareSelection?(
		action: AgentSelectorAction,
		tui: TUI,
	): Promise<void> | void;
	onSelectionError?(error: unknown): void;
}>;

type AgentSelectorItem = SelectItem & Readonly<{
	status?: AgentRosterStatus;
	kind: "decide" | "attention" | "owner" | "agent";
	childControl?: string;
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
	#options: AgentSelectorOptions;
	#removeChangeHandler: (() => void) | undefined;
	#activeTab: "live" | "dormant" = "live";
	#scopeAgentId: string;
	#selectedValueByTab: { live?: string; dormant?: string };
	#items: AgentSelectorItem[] = [];
	#selectedIndex = 0;
	#visibleRows = 1;
	#list: SelectList;
	#selectionPending = false;
	#selectionSpinnerFrame = 0;
	#selectionSpinnerItem: AgentSelectorItem | undefined;
	#selectionSpinnerDescription: string | undefined;
	#selectionSpinnerTimer: ReturnType<typeof setInterval> | undefined;

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
		const selectedLive = options.live.find(
			({ agentId }) => agentId === options.selectedAgentId,
		);
		const selectedDormant = options.dormant.find(
			({ agentId }) => agentId === options.selectedAgentId,
		);
		this.#activeTab = selectedDormant ? "dormant" : "live";
		this.#scopeAgentId = selectedLive?.agentId === owner.agentId
			? owner.agentId
			: selectedLive?.directSpawnerAgentId ?? owner.agentId;
		this.#selectedValueByTab = {
			live: this.#attentionItems()[0]?.value ?? (
				selectedLive?.agentId !== owner.agentId ? selectedLive?.agentId : undefined
			),
			dormant: selectedDormant?.agentId ?? options.dormant[0]?.agentId,
		};
		this.#list = this.#createList();
		this.#removeChangeHandler = options.addChangeHandler?.((snapshot) => {
			this.#options = { ...this.#options, ...snapshot };
			this.#list = this.#createList();
			if (this.#selectionSpinnerTimer) {
				this.#selectionSpinnerItem = this.#items[this.#selectedIndex];
				this.#selectionSpinnerDescription = this.#selectionSpinnerItem?.description;
				this.#updateSelectionSpinner();
			}
			this.#tui.requestRender();
		});
	}

	handleInput(data: string): void {
		if (this.#selectionPending) return;
		if (matchesKey(data, Key.escape)) {
			this.#done(undefined);
			return;
		}
		if (matchesKey(data, "o")) {
			void this.#completeSelection({
				kind: "select_agent",
				agentId: this.#ownerStatus().agentId,
			}, false);
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
		// SelectList wraps by default; Owner is a boundary, never a wrap destination.
		if (
			(matchesKey(listInput, Key.up) && this.#selectedIndex === 0) ||
			(matchesKey(listInput, Key.down) && this.#selectedIndex === this.#items.length - 1)
		) return;
		this.#list.handleInput(listInput);
		this.#tui.requestRender();
	}

	invalidate(): void {
		this.#list.invalidate();
	}

	dispose(): void {
		this.#removeChangeHandler?.();
		this.#removeChangeHandler = undefined;
		this.#stopSelectionSpinner();
	}

	render(width: number): string[] {
		const frameWidth = Math.min(width, AGENT_SELECTOR_OVERLAY_WIDTH);
		const innerWidth = Math.max(1, frameWidth - 2);
		const contentWidth = Math.max(1, innerWidth - 2);
		const border = (text: string) => this.#theme.fg("border", text);
		const contentLines = [
			this.#renderTabs(),
			"",
			...this.#renderPinnedList(contentWidth),
			"",
			this.#theme.fg(
				"dim",
				"o Owner · Tab views · ↑/k ↓/j · →/l children · ←/h parent · Enter · Esc",
			),
		];
		const visibleContentLines = fitOverlayContent(
			contentLines,
			Math.max(0, this.#maximumOverlayRows() - FRAME_ROWS),
		);
		// Fixed inner padding keeps roster content and focus changes from shifting
		// every row horizontally.
		const blockWidth = contentWidth;
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
			: [this.#ownerItem(), ...this.#options.dormant.map((status) => this.#agentItem(status))];
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
		const preferredIndex = this.#items.findIndex(({ value }) => value === preferredValue);
		this.#selectedIndex = preferredIndex >= 0 ? preferredIndex : Math.max(
			0, this.#items.findIndex(({ kind }) => kind !== "owner"),
		);
		// Rebuilds must remember the resolved fallback, not an absent preferred item.
		this.#selectedValueByTab[this.#activeTab] = this.#items[this.#selectedIndex]?.value;
		list.setSelectedIndex(this.#selectedIndex);
		list.onSelectionChange = (selected) => {
			const index = this.#items.indexOf(selected as AgentSelectorItem);
			if (index < 0) return;
			this.#selectedIndex = index;
			this.#selectedValueByTab[this.#activeTab] = selected.value;
		};
		list.onSelect = ({ value }) => {
			const selected = this.#items.find((item) => item.value === value);
			if (!selected) return;
			const action = selected.action ?? (selected.status
				? { kind: "select_agent" as const, agentId: value }
				: undefined);
			// Informational rows remain focusable, but Enter must not close the overlay.
			if (!action) return;
			void this.#completeSelection(action);
		};
		list.onCancel = () => this.#done(undefined);
		return list;
	}

	async #completeSelection(
		action: AgentSelectorAction,
		showSelectionSpinner = true,
	): Promise<void> {
		if (this.#selectionPending) return;
		this.#selectionPending = true;
		if (showSelectionSpinner) this.#startSelectionSpinner();
		try {
			const preparation = this.#options.prepareSelection?.(action, this.#tui);
			if (preparation) await preparation;
			this.#stopSelectionSpinner();
			this.#done(action);
		} catch (error) {
			this.#selectionPending = false;
			this.#stopSelectionSpinner();
			this.#options.onSelectionError?.(error);
			this.#tui.requestRender();
		}
	}

	#startSelectionSpinner(): void {
		this.#selectionSpinnerFrame = 0;
		this.#selectionSpinnerItem = this.#items[this.#selectedIndex];
		this.#selectionSpinnerDescription = this.#selectionSpinnerItem?.description;
		this.#updateSelectionSpinner();
		this.#selectionSpinnerTimer = setInterval(() => {
			this.#selectionSpinnerFrame =
				(this.#selectionSpinnerFrame + 1) % SELECTION_SPINNER_FRAMES.length;
			this.#updateSelectionSpinner();
		}, SELECTION_SPINNER_INTERVAL_MILLISECONDS);
	}

	#updateSelectionSpinner(): void {
		if (this.#selectionSpinnerItem) {
			this.#selectionSpinnerItem.description =
				`${SELECTION_SPINNER_FRAMES[this.#selectionSpinnerFrame]} loading`;
		}
		this.#tui.requestRender();
	}

	#stopSelectionSpinner(): void {
		if (this.#selectionSpinnerTimer) clearInterval(this.#selectionSpinnerTimer);
		this.#selectionSpinnerTimer = undefined;
		if (this.#selectionSpinnerItem) {
			if (this.#selectionSpinnerDescription === undefined) {
				delete this.#selectionSpinnerItem.description;
			} else {
				this.#selectionSpinnerItem.description = this.#selectionSpinnerDescription;
			}
		}
		this.#selectionSpinnerItem = undefined;
		this.#selectionSpinnerDescription = undefined;
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
			this.#ownerItem(),
			...this.#options.live
				.filter((status) =>
					status.agentId !== owner.agentId &&
					(
						status.directSpawnerAgentId === this.#scopeAgentId ||
						(
							this.#scopeAgentId === owner.agentId &&
							status.directSpawnerAgentId === null
						)
					)
				)
				.map((status) => this.#agentItem(status)),
		];
	}

	#attentionItems(): AgentSelectorItem[] {
		const human = (this.#options.humanAttention ?? []).map((attention, index) => ({
			value: `human:${attention.requestId}`,
			label: `DECIDE ${index + 1} · ${attention.agentLabel}`,
			description: boundedToolPreview(attention.question),
			kind: "decide" as const,
			action: {
				kind: "decide" as const,
				requestId: attention.requestId,
				agentId: attention.agentId,
			},
			detailLines: [
				"",
				`Agent ${attention.agentId}`,
				boundedToolPreview(attention.question),
				`Human Request ${attention.requestId}`,
			],
		}));
		const operational = (this.#options.operationalAttention ?? []).map(
			(attention, index) => {
				const requests = operationalIncidentRequestEvidence(attention);
				const affectedAgentId = attention.affectedAgents.length === 1
					? attention.affectedAgents[0]!.agentId
					: undefined;
				return {
					value: `operational:${index}`,
					label: `ATTENTION ${index + 1} · ${formatOperationalIncidentHeadline(attention)}`,
					kind: "attention" as const,
					action: affectedAgentId
						? { kind: "select_agent" as const, agentId: affectedAgentId }
						: undefined,
					detailLines: [
						"",
						...(attention.summary ? [attention.summary] : []),
						`Affected ${attention.affectedAgents.map(({ label }) => label).join(", ")}`,
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

	#agentItem(status: AgentRosterStatus): AgentSelectorItem {
		const childCount = this.#options.live.filter(
			(candidate) => candidate.directSpawnerAgentId === status.agentId,
		).length;
		const children = childCount === 0
			? undefined
			: `[${childCount} ${childCount === 1 ? "child" : "children"} ›]`;
		const moderator = status.agentId !== status.workflowId &&
			status.directSpawnerAgentId === null;
		return {
			value: status.agentId,
			label: status.label,
			description: [
				formatRun(status, this.#theme),
				moderator ? status.description : undefined,
			].filter(Boolean).join(" · "),
			status,
			kind: "agent",
			childControl: this.#activeTab === "live" ? children : undefined,
		};
	}

	#ownerStatus(): AgentRosterStatus {
		const owner = this.#options.live.find(
			(status) => status.agentId === status.workflowId,
		);
		if (!owner) throw new Error("Agent selector roster has no live Owner");
		return owner;
	}

	#ownerItem(): AgentSelectorItem {
		return {
			value: this.#ownerStatus().agentId,
			label: "Owner",
			kind: "owner",
			action: { kind: "select_agent", agentId: this.#ownerStatus().agentId },
		};
	}

	#renderPinnedList(width: number): string[] {
		const startIndex = Math.max(0, Math.min(
			this.#selectedIndex - Math.floor(this.#visibleRows / 2),
			this.#items.length - this.#visibleRows,
		));
		const visibleItems = this.#items.slice(startIndex, startIndex + this.#visibleRows);
		const listLines = this.#list.render(width);
		const hasAgents = this.#items.some(({ kind }) => kind === "agent");
		const visibleAttention = visibleItems.some(({ kind }) => kind === "decide" || kind === "attention");
		const visibleBodyRows = visibleItems.filter(({ kind }) => kind !== "owner").length;
		// On very short terminals, trim detail only as needed to keep the pinned
		// Owner boundary alongside the focused summary and the existing frame.
		const detailRows = Math.max(0, Math.min(FOCUSED_DETAIL_ROWS,
			this.#maximumOverlayRows() - FRAME_ROWS - TAB_ROWS - 1 -
			(visibleAttention ? 1 : 0) - visibleBodyRows - (!hasAgents ? 1 : 0) -
			(listLines.length > visibleItems.length ? SCROLL_INDICATOR_ROWS : 0),
		));
		const attention: string[] = [];
		const agents: string[] = [];
		for (const [offset, item] of visibleItems.entries()) {
			if (item.kind === "owner") continue;
			const lines = item.kind === "agent" ? agents : attention;
			let line = listLines[offset] ?? "";
			if (item.childControl) {
				// Reserve the hierarchy action before truncating the participant body.
				const bodyWidth = Math.max(0, width - visibleWidth(item.childControl) - 1);
				line = truncateToWidth(line, bodyWidth, "");
				line += " ".repeat(Math.max(1, width - visibleWidth(line) - visibleWidth(item.childControl)));
				line += this.#theme.fg("dim", item.childControl);
			}
			lines.push(line);
			if (startIndex + offset === this.#selectedIndex) {
				lines.push(...this.#focusedDetailLines(item, width).slice(0, detailRows));
			}
		}
		const ownerFocused = this.#items[this.#selectedIndex]?.kind === "owner";
		const owner = ownerFocused
			? this.#theme.bg("selectedBg", this.#theme.fg("text", "[Owner]"))
			: this.#theme.fg("toolTitle", "[Owner]");
		const ownerLine = this.#activeTab === "live"
			? owner + this.#theme.fg("toolTitle", this.#scopeTitle(Math.max(0, width - visibleWidth("[Owner]"))))
			: owner;
		const rendered = [
			...(attention.length ? [this.#theme.fg("toolTitle", this.#theme.bold("Attention Inbox")), ...attention] : []),
			ownerLine + (ownerFocused && this.#selectionSpinnerItem?.description
				? this.#theme.fg("dim", ` ${this.#selectionSpinnerItem.description}`) : ""),
			...agents,
			...(!hasAgents ? [this.#theme.fg("dim", this.#activeTab === "live" ? "  No live Agents" : "  No dormant Agents")] : []),
		];
		// Pinned Owner replaces its list row. Reserve missing window/header slots so
		// moving across the boundary does not resize the established detail layout.
		const targetRows = this.#visibleRows + FOCUSED_DETAIL_ROWS +
			(this.#activeTab === "live" ? MAX_LIVE_SECTION_HEADER_ROWS : 1) +
			(!hasAgents ? 1 : 0);
		while (rendered.length < targetRows) rendered.push("");
		return [...rendered, ...listLines.slice(visibleItems.length)];
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
		if (selected?.kind === "owner") {
			const owner = this.#ownerStatus();
			let ancestor = [...this.#options.live, ...this.#options.dormant].find(
				({ agentId }) => agentId === this.#scopeAgentId,
			);
			while (ancestor?.directSpawnerAgentId && ancestor.directSpawnerAgentId !== owner.agentId) {
				const parentId = ancestor.directSpawnerAgentId;
				ancestor = [...this.#options.live, ...this.#options.dormant].find(
					({ agentId }) => agentId === parentId,
				);
			}
			this.#scopeAgentId = owner.agentId;
			const rootAgents = this.#liveItems().filter(({ kind }) => kind === "agent");
			// Root browsing targets an Agent, not the higher-priority Attention Inbox.
			this.#selectedValueByTab.live = rootAgents.find(({ value }) => value === ancestor?.agentId)?.value
				?? rootAgents[0]?.value ?? owner.agentId;
			this.#list = this.#createList();
			return;
		}
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
		if (labels.length === 0) return "[›]";
		const visibleLabels = labels.slice(-MAX_BREADCRUMB_AGENT_SEGMENTS);
		const title = () =>
			`[›] ${labels.length > visibleLabels.length ? "… / " : ""}${visibleLabels.join(" / ")}`;
		while (visibleLabels.length > 1 && visibleWidth(title()) > width) {
			visibleLabels.shift();
		}
		if (visibleWidth(title()) <= width) return title();
		const prefix = labels.length > 1 ? "[›] … / " : "[›] ";
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

function formatRun(status: AgentRosterStatus, theme: Theme): string {
	return formatAgentWorkStatus(selectedAgentWorkStatus(status.run, false, status.compacting), theme);
}

function formatDetailedRun(status: AgentRosterStatus): string {
	const { run } = status;
	const state = run.phase === "dormant"
		? ["Dormant"]
		: [
			capitalize(run.phase),
			run.work,
			run.attention === "input_required"
				? "input required"
				: run.attention === "agent_wait" ? "agent answers" : undefined,
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
