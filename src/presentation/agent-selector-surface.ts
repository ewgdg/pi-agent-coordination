import type {
	ExtensionUIContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Key,
	SelectList,
	compositeTuiLine,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type SelectItem,
	type SelectListTheme,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
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
				margin: { top: AGENT_SELECTOR_OVERLAY_MARGIN, bottom: AGENT_SELECTOR_OVERLAY_MARGIN },
			},
		},
	);
}

type PointerAction =
	| { kind: "tab"; tab: "live" | "dormant" }
	| { kind: "open"; value: string }
	| { kind: "children"; value: string }
	| { kind: "ancestor"; agentId: string; childId: string };

type LineRegion = Readonly<{ start: number; end: number; text: string; action: PointerAction }>;
type SelectorLine = Readonly<{ text: string; regions?: readonly LineRegion[]; roster?: boolean }>;
type HitRegion = LineRegion & Readonly<{ row: number }>;

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
	#rosterScrollOffset = 0;
	#list: SelectList;
	#selectionPending = false;
	#hitRegions: HitRegion[] = [];
	#rosterRows = new Set<number>();
	#contentLeft = 0;
	#contentWidth = 0;
	#hoveredAction: PointerAction | undefined;
	#pressedAction: PointerAction | undefined;
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
			this.#list = this.#createList(true);
			this.#tui.requestRender();
		});
	}

	handleInput(data: string): void {
		if (this.#selectionPending) return;
		this.#hoveredAction = undefined;
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
		) {
			// A boundary key still restores the selected row after wheel scrolling.
			this.#ensureSelectedVisible();
			this.#tui.requestRender();
			return;
		}
		this.#list.handleInput(listInput);
		this.#ensureSelectedVisible();
		this.#tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		// Leave non-primary buttons to Pi/terminal behavior, never selector actions.
		if (event.button === "middle" || event.button === "right") return undefined;
		if (this.#selectionPending) return { handled: true };
		const region = this.#hitRegions.find(({ start, end, row }) =>
			event.y === row && event.x >= start && event.x < end &&
			event.x < event.width && event.y < event.height
		);
		if (event.type === "move") {
			const action = region?.action;
			const changed = !samePointerAction(this.#hoveredAction, action);
			this.#hoveredAction = action;
			return { handled: true, render: changed };
		}
		if (event.type === "wheel") {
			if (this.#rosterRows.has(event.y) &&
				event.x >= this.#contentLeft && event.x < this.#contentLeft + this.#contentWidth &&
				event.wheelDelta) {
				// Wheel browses the visible roster independently from selection.
				const delta = event.wheelDelta < 0 ? -1 : 1;
				const maximumOffset = this.#maximumRosterScrollOffset();
				const nextOffset = Math.max(0, Math.min(
					maximumOffset, this.#rosterScrollOffset + delta,
				));
				const changed = nextOffset !== this.#rosterScrollOffset;
				this.#rosterScrollOffset = nextOffset;
				this.#hoveredAction = undefined;
				return { handled: true, render: changed };
			}
			return { handled: true };
		}
		if (event.button !== "left") return { handled: true };
		if (event.type === "press") {
			this.#pressedAction = region?.action;
			return { handled: true, capture: true };
		}
		if (event.type === "click") {
			const action = region?.action;
			if (action && (!this.#pressedAction || samePointerAction(this.#pressedAction, action))) {
				this.#activatePointerAction(action);
			}
			this.#pressedAction = undefined;
		}
		return { handled: true };
	}

	#activatePointerAction(action: PointerAction): void {
		this.#hoveredAction = undefined;
		if (action.kind === "tab") {
			this.#activeTab = action.tab;
			this.#list = this.#createList();
		} else if (action.kind === "ancestor") {
			this.#scopeAgentId = action.agentId;
			this.#selectedValueByTab.live = action.childId;
			this.#list = this.#createList();
		} else {
			const index = this.#items.findIndex(({ value }) => value === action.value);
			if (index < 0) return;
			this.#selectedIndex = index;
			this.#selectedValueByTab[this.#activeTab] = action.value;
			this.#list.setSelectedIndex(index);
			if (action.kind === "children") this.#zoomIn();
			else this.#selectItem(action.value);
		}
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
		const terminalRows = this.#tui.terminal.rows;
		const frameWidth = Math.min(width, AGENT_SELECTOR_OVERLAY_WIDTH);
		const innerWidth = Math.max(0, frameWidth - 2);
		const contentWidth = Math.max(0, innerWidth - 2);
		const border = (text: string) => this.#theme.fg("border", text);
		// Resize changes the list's visible window as well as its hit regions.
		const visibleRows = this.#maximumVisibleRows();
		if (visibleRows !== this.#visibleRows) {
			const selectedVisible = this.#selectedIndex >= this.#rosterScrollOffset &&
				this.#selectedIndex < this.#rosterScrollOffset + this.#visibleRows;
			this.#list = this.#createList(true, selectedVisible);
		}
		const contentLines: SelectorLine[] = [
			this.#renderTabs(),
			{ text: "" },
			...this.#renderPinnedList(contentWidth),
			{ text: "" },
			{ text: this.#theme.fg(
				"dim",
				"o Owner · Tab views · ↑/k ↓/j · →/l children · ←/h parent · Enter · Esc",
			) },
		];
		const visibleContentLines = fitOverlayContent(
			contentLines,
			Math.max(0, this.#maximumOverlayRows() - FRAME_ROWS),
		);
		const leftMargin = Math.min(1, innerWidth);
		const rightMargin = Math.max(0, innerWidth - contentWidth - leftMargin);
		this.#contentLeft = 1 + leftMargin;
		this.#contentWidth = contentWidth;
		this.#hitRegions = [];
		this.#rosterRows.clear();
		const panel = [
			border(`┌${"─".repeat(innerWidth)}┐`),
			...visibleContentLines.map((line, index) => {
				const row = index + 1;
				if (line.roster) this.#rosterRows.add(row);
				for (const region of line.regions ?? []) {
					// A partially clipped control is informational, not a different action.
					if (region.end > contentWidth || region.start >= region.end || row >= terminalRows) continue;
					this.#hitRegions.push({
						...region, row,
						start: this.#contentLeft + region.start,
						end: this.#contentLeft + region.end,
					});
				}
				let text = line.text;
				for (const region of line.regions ?? []) {
					if (region.end > contentWidth || region.start >= region.end) continue;
					const selected = region.action.kind === "tab"
						? region.action.tab === this.#activeTab
						: region.action.kind === "open" && region.action.value === this.#items[this.#selectedIndex]?.value;
					const hovered = samePointerAction(region.action, this.#hoveredAction);
					if (!selected && !hovered) continue;
					// userMessageBg is the neutral, subtler surface in both bundled themes.
					// Selection wins; the child button is a separate action, not part of it.
					const background = selected ? "selectedBg" : "userMessageBg";
					const regionWidth = region.end - region.start;
					// Keep each action's styled text at construction time instead of slicing
					// ANSI-painted lines, which can replay neighboring foreground codes.
					let label = truncateToWidth(region.text, regionWidth, "");
					label += " ".repeat(Math.max(0, regionWidth - visibleWidth(label)));
					// Truncation may reset all ANSI styles before the action's padding.
					if (label.includes("\x1b[0m")) {
						label = label.replaceAll("\x1b[0m", "\x1b[0m" + this.#theme.getBgAnsi(background));
					}
					text = compositeTuiLine(text, this.#theme.bg(background, label),
						region.start, regionWidth, contentWidth);
				}
				return frameLine(text, contentWidth, leftMargin, rightMargin, border);
			}),
			border(`└${"─".repeat(innerWidth)}┘`),
		];
		// Paint only the panel: a full-terminal blank overlay erases the chat below.
		return panel;
	}

	#maximumVisibleRows(): number {
		return Math.max(1, Math.min(
			this.#items.length, MAX_VISIBLE_ROSTER_ROWS,
			this.#maximumOverlayRows() - FIXED_OVERLAY_ROWS - SCROLL_INDICATOR_ROWS,
		));
	}

	#createList(preserveScroll = false, ensureSelection = false): SelectList {
		this.#items = this.#activeTab === "live"
			? this.#liveItems()
			: [this.#ownerItem(), ...this.#options.dormant.map((status) => this.#agentItem(status))];
		this.#hitRegions = [];
		this.#rosterRows.clear();
		this.#visibleRows = this.#maximumVisibleRows();
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
		if (preserveScroll) {
			this.#rosterScrollOffset = Math.min(
				this.#rosterScrollOffset, this.#maximumRosterScrollOffset(),
			);
		} else {
			this.#rosterScrollOffset = Math.max(0, Math.min(
				this.#selectedIndex - Math.floor(this.#visibleRows / 2),
				this.#maximumRosterScrollOffset(),
			));
		}
		list.onSelectionChange = (selected) => {
			const index = this.#items.indexOf(selected as AgentSelectorItem);
			if (index < 0) return;
			this.#selectedIndex = index;
			this.#selectedValueByTab[this.#activeTab] = selected.value;
		};
		if (!preserveScroll || ensureSelection) this.#ensureSelectedVisible();
		list.onSelect = ({ value }) => this.#selectItem(value);
		list.onCancel = () => this.#done(undefined);
		// Both live refresh and resize rebuild items while preparation can be pending.
		if (this.#selectionSpinnerTimer) {
			this.#selectionSpinnerItem = this.#items[this.#selectedIndex];
			this.#selectionSpinnerDescription = this.#selectionSpinnerItem?.description;
			this.#updateSelectionSpinner();
		}
		return list;
	}

	#selectItem(value: string): void {
		const selected = this.#items.find((item) => item.value === value);
		if (!selected) return;
		const action = selected.action ?? (selected.status
			? { kind: "select_agent" as const, agentId: value }
			: undefined);
		// Keyboard confirmation and pointer activation share actions, not keybindings.
		// Informational rows remain focusable without dismissing the selector.
		if (action) void this.#completeSelection(action);
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

	#liveChildren(agentId: string): AgentRosterStatus[] {
		const ownerId = this.#ownerStatus().agentId;
		// Root browsing also includes live Moderators without a direct Spawner.
		return this.#options.live.filter((status) =>
			status.agentId !== ownerId &&
			(status.directSpawnerAgentId === agentId ||
				(agentId === ownerId && status.directSpawnerAgentId === null))
		);
	}

	#liveItems(): AgentSelectorItem[] {
		return [
			...this.#attentionItems(),
			this.#ownerItem(),
			...this.#liveChildren(this.#scopeAgentId).map((status) => this.#agentItem(status)),
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
		const childCount = this.#liveChildren(status.agentId).length;
		const children = childCount === 0
			? undefined
			: `${childCount} ${childCount === 1 ? "child" : "children"} ›`;
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

	#maximumRosterScrollOffset(): number {
		return Math.max(0, this.#items.length - this.#visibleRows);
	}

	#ensureSelectedVisible(): void {
		const maximumOffset = this.#maximumRosterScrollOffset();
		if (this.#selectedIndex < this.#rosterScrollOffset) {
			this.#rosterScrollOffset = this.#selectedIndex;
		} else if (this.#selectedIndex >= this.#rosterScrollOffset + this.#visibleRows) {
			this.#rosterScrollOffset = this.#selectedIndex - this.#visibleRows + 1;
		}
		this.#rosterScrollOffset = Math.max(0, Math.min(this.#rosterScrollOffset, maximumOffset));
	}

	#renderRosterViewport(width: number, startIndex: number, visibleItems: AgentSelectorItem[]): string[] {
		const selectedOffset = this.#selectedIndex - startIndex;
		const selectedVisible = selectedOffset >= 0 && selectedOffset < visibleItems.length;
		const theme = selectedVisible
			? this.#selectListTheme()
			: {
				selectedPrefix: (text: string) => text,
				selectedText: (text: string) => text.startsWith("→ ") ? "  " + text.slice(2) : text,
				description: (text: string) => this.#theme.fg("dim", text),
				scrollInfo: (text: string) => this.#theme.fg("muted", text),
				noMatch: (text: string) => this.#theme.fg("muted", text),
			};
		const viewport = new SelectList(visibleItems, Math.max(1, visibleItems.length), theme);
		viewport.setSelectedIndex(selectedVisible ? selectedOffset : 0);
		const lines = viewport.render(width).slice(0, visibleItems.length);
		if (startIndex > 0 || startIndex + visibleItems.length < this.#items.length) {
			const range = `  (${this.#selectedIndex + 1}/${this.#items.length})`;
			lines.push(this.#theme.fg("muted", truncateToWidth(range, Math.max(0, width - 2), "")));
		}
		return lines;
	}

	#renderPinnedList(width: number): SelectorLine[] {
		const startIndex = Math.max(0, Math.min(
			this.#rosterScrollOffset, this.#maximumRosterScrollOffset(),
		));
		const visibleItems = this.#items.slice(startIndex, startIndex + this.#visibleRows);
		const listLines = this.#renderRosterViewport(width, startIndex, visibleItems);
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
		const attention: SelectorLine[] = [];
		const agents: SelectorLine[] = [];
		for (const [offset, item] of visibleItems.entries()) {
			if (item.kind === "owner") continue;
			const lines = item.kind === "agent" ? agents : attention;
			let line = listLines[offset] ?? "";
			let bodyText = line;
			const regions: LineRegion[] = [];
			let bodyEnd = width;
			if (item.childControl) {
				// Reserve the hierarchy action before truncating the participant body.
				const childWidth = visibleWidth(item.childControl);
				const bodyWidth = Math.max(0, width - childWidth - 1);
				line = truncateToWidth(line, bodyWidth, "");
				if (childWidth <= width) {
					// Leave one unowned cell between independent controls, matching tabs and Owner.
					const bodyTextWidth = visibleWidth(line);
					const childStart = Math.max(bodyTextWidth + 1, width - childWidth);
					line += " ".repeat(Math.max(1, childStart - bodyTextWidth));
					bodyEnd = childStart - 1;
					regions.push({ start: childStart, end: childStart + childWidth,
						text: this.#theme.fg("dim", item.childControl),
						action: { kind: "children", value: item.value } });
				} else {
					line += " ".repeat(Math.max(1, width - visibleWidth(line) - childWidth));
					// Never turn the clipped child-control fragment into an open action.
					bodyEnd = 0;
				}
				bodyText = line;
				line += this.#theme.fg("dim", item.childControl);
			}
			if (item.action || item.status) {
				regions.push({ start: 0, end: bodyEnd, text: bodyText, action: { kind: "open", value: item.value } });
			}
			lines.push({ text: line, regions, roster: true });
			if (startIndex + offset === this.#selectedIndex) {
				// Details are informational: no click or wheel region.
				lines.push(...this.#focusedDetailLines(item, width)
					.slice(0, detailRows).map((text) => ({ text })));
			}
		}
		const ownerFocused = this.#items[this.#selectedIndex]?.kind === "owner";
		const owner = ownerFocused
			? this.#theme.bg("selectedBg", this.#theme.fg("text", "Owner"))
			: this.#theme.fg("toolTitle", "Owner");
		const ownerWidth = visibleWidth(owner);
		const path = this.#activeTab === "live"
			? this.#scopeTitle(Math.max(0, width - ownerWidth))
			: { text: "", regions: [] };
		const ownerLine: SelectorLine = {
			text: owner + this.#theme.fg("toolTitle", path.text) +
				(ownerFocused && this.#selectionSpinnerItem?.description
					? this.#theme.fg("dim", ` ${this.#selectionSpinnerItem.description}`) : ""),
			regions: [
				{ start: 0, end: ownerWidth, text: owner, action: { kind: "open", value: this.#ownerStatus().agentId } },
				...(path.regions ?? []).map((region) => ({
					...region, start: region.start + ownerWidth, end: region.end + ownerWidth,
				})),
			],
		};
		const rendered: SelectorLine[] = [
			...(attention.length ? [{ text: this.#theme.fg("toolTitle", this.#theme.bold("Attention Inbox")) }, ...attention] : []),
			ownerLine,
			...agents,
			...(!hasAgents ? [{ text: this.#theme.fg("dim", this.#activeTab === "live" ? "  No live Agents" : "  No dormant Agents") }] : []),
		];
		// Pinned Owner replaces its list row. Reserve missing window/header slots so
		// moving across the boundary does not resize the established detail layout.
		const targetRows = this.#visibleRows + FOCUSED_DETAIL_ROWS +
			(this.#activeTab === "live" ? MAX_LIVE_SECTION_HEADER_ROWS : 1) +
			(!hasAgents ? 1 : 0);
		while (rendered.length < targetRows) rendered.push({ text: "", roster: true });
		return [...rendered, ...listLines.slice(visibleItems.length).map((text) => ({ text, roster: true }))];
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
			if (this.#liveChildren(owner.agentId).length === 0) return;
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
		const firstChild = this.#liveChildren(selected.value)[0];
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

	#scopeTitle(width: number): SelectorLine {
		const allStatuses = [...this.#options.live, ...this.#options.dormant];
		const owner = this.#ownerStatus();
		const ancestors: AgentRosterStatus[] = [];
		const scope = allStatuses.find(({ agentId }) => agentId === this.#scopeAgentId);
		let current = scope;
		while (current && current.agentId !== owner.agentId) {
			ancestors.unshift(current);
			current = allStatuses.find(
				({ agentId }) => agentId === current?.directSpawnerAgentId,
			);
		}
		const rootControl = this.#liveChildren(owner.agentId).length > 0 ? "›" : "";
		const regions: LineRegion[] = rootControl ? [{
			start: 1, end: 1 + visibleWidth(rootControl), text: this.#theme.fg("toolTitle", rootControl),
			action: { kind: "children", value: owner.agentId },
		}] : [];
		// The gap between Owner and root navigation is outside both hit regions.
		const rootSuffix = rootControl ? ` ${rootControl}` : "";
		if (ancestors.length === 0) return { text: rootSuffix, regions };
		const visibleAncestors = ancestors.slice(-MAX_BREADCRUMB_AGENT_SEGMENTS);
		const rootPrefix = `${rootSuffix || " /"} `;
		const prefix = () => rootPrefix + (ancestors.length > visibleAncestors.length ? "… / " : "");
		const title = () => prefix() + visibleAncestors.map(({ label }) => label).join(" / ");
		while (visibleAncestors.length > 1 && visibleWidth(title()) > width) {
			visibleAncestors.shift();
		}
		if (visibleWidth(title()) <= width) {
			let column = visibleWidth(prefix());
			for (const [index, ancestor] of visibleAncestors.entries()) {
				const child = visibleAncestors[index + 1];
				const action = child
					? { kind: "ancestor" as const, agentId: ancestor.agentId, childId: child.agentId }
					: scope
						? {
							kind: "ancestor" as const,
							agentId: scope.directSpawnerAgentId ?? owner.agentId,
							childId: scope.agentId,
						}
						: undefined;
				if (action) regions.push({
					start: column, end: column + visibleWidth(ancestor.label),
					text: this.#theme.fg("toolTitle", ancestor.label),
					action,
				});
				column += visibleWidth(ancestor.label) + visibleWidth(" / ");
			}
			return { text: title(), regions };
		}
		// Omitted and clipped path text is informational, never a partial action.
		return { text: rootPrefix + truncateToWidth(
			visibleAncestors.at(-1)?.label ?? "",
			Math.max(0, width - visibleWidth(rootPrefix)), "…",
		), regions };
	}

	#renderTabs(): SelectorLine {
		const tab = (name: "Live" | "Dormant", active: boolean) =>
			active
				? this.#theme.bg("selectedBg", this.#theme.fg("text", ` ${name} `))
				: this.#theme.fg("muted", ` ${name} `);
		const live = tab("Live", this.#activeTab === "live");
		const dormant = tab("Dormant", this.#activeTab === "dormant");
		const dormantStart = visibleWidth(live) + 1;
		return {
			text: `${live} ${dormant}`,
			regions: [
				{ start: 0, end: visibleWidth(live), text: live, action: { kind: "tab", tab: "live" } },
				{ start: dormantStart, end: dormantStart + visibleWidth(dormant), text: dormant, action: { kind: "tab", tab: "dormant" } },
			],
		};
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

function fitOverlayContent(lines: SelectorLine[], maximumRows: number): SelectorLine[] {
	const content = [...lines];
	while (content.length > maximumRows) {
		const emptyLine = content.findLastIndex((line) => visibleWidth(line.text) === 0);
		if (emptyLine < 0) break;
		content.splice(emptyLine, 1);
	}
	if (content.length > maximumRows) content.pop();
	return content.slice(0, maximumRows);
}

function samePointerAction(left: PointerAction | undefined, right: PointerAction | undefined): boolean {
	if (!left || !right) return left === right;
	switch (left.kind) {
		case "tab": return right.kind === "tab" && left.tab === right.tab;
		case "open":
		case "children": return right.kind === left.kind && left.value === right.value;
		case "ancestor": return right.kind === "ancestor" &&
			left.agentId === right.agentId && left.childId === right.childId;
	}
}

function frameLine(
	line: string,
	blockWidth: number,
	leftMargin: number,
	rightMargin: number,
	border: (text: string) => string,
): string {
	// Compositing may end on a styled cell; frame padding must never inherit it.
	const content = truncateToWidth(line, blockWidth, "") + "\x1b[0m";
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
