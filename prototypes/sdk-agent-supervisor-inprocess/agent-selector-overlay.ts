import {
	type ExtensionUIContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	SelectList,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type SelectItem,
	type SelectListTheme,
	type TUI,
} from "@earendil-works/pi-tui";

const MAX_VISIBLE_AGENT_ROWS = 10;
const MAX_BREADCRUMB_AGENT_SEGMENTS = 3;
const OVERLAY_WIDTH = 80;
const OVERLAY_MARGIN = 1;
const BASE_OVERLAY_CHROME_ROWS = 4;
const ATTENTION_SECTION_ROWS = 1;
const OWNER_SECTION_ROWS = 1;
const FOCUSED_DETAIL_ROWS = 2;
const SCROLL_INDICATOR_ROWS = 1;
const MINIMUM_INNER_MARGIN = 1;
const SELECT_LIST_UP_INPUT = "\x1b[A";
const SELECT_LIST_DOWN_INPUT = "\x1b[B";

export type AgentSelectorItem = SelectItem & {
	kind?: "attention" | "agent";
	parentValue?: string;
	detailLines?: readonly [string, string];
};

export function openAgentSelectorOverlay(
	ui: ExtensionUIContext,
	items: AgentSelectorItem[],
	selectedValue: string,
): Promise<string | undefined> {
	return ui.custom<string | undefined>(
		(tui, theme, _keybindings, done) =>
			new AgentSelectorOverlay(tui, theme, items, selectedValue, done),
		{
			overlay: true,
			overlayOptions: {
				width: OVERLAY_WIDTH,
				maxHeight: "90%",
				anchor: "center",
				margin: OVERLAY_MARGIN,
			},
		},
	);
}

class AgentSelectorOverlay implements Component {
	readonly #tui: TUI;
	readonly #theme: Theme;
	readonly #attentionItems: AgentSelectorItem[];
	readonly #agentItems: AgentSelectorItem[];
	readonly #done: (result: string | undefined) => void;
	#scopeValue: string;
	#items: AgentSelectorItem[];
	#selectedIndex: number;
	#visibleRows = 0;
	#selectList: SelectList | undefined;

	constructor(
		tui: TUI,
		theme: Theme,
		items: AgentSelectorItem[],
		selectedValue: string,
		done: (result: string | undefined) => void,
	) {
		this.#tui = tui;
		this.#theme = theme;
		this.#attentionItems = items.filter(({ kind }) => kind === "attention");
		this.#agentItems = items.filter(({ kind }) => kind !== "attention");
		const selectedAgent = this.#agentItems.find(({ value }) => value === selectedValue);
		if (!selectedAgent) throw new Error(`Selected Agent is absent from roster: ${selectedValue}`);
		this.#scopeValue = selectedAgent.parentValue ?? selectedAgent.value;
		this.#items = [];
		this.#selectedIndex = 0;
		this.#done = done;
		this.#rebuildItems(
			this.#attentionItems.length > 0 ? "attention" : "agent",
			this.#attentionItems[0]?.value ?? selectedValue,
		);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "right") || matchesKey(data, "l")) {
			this.#zoomIn();
			this.#tui.requestRender();
			return;
		}
		if (matchesKey(data, "left") || matchesKey(data, "h")) {
			this.#zoomOut();
			this.#tui.requestRender();
			return;
		}
		this.#synchronizeListHeight();
		// Translate Vim aliases to arrows so SelectList remains the sole owner of
		// wrapping, selection changes, confirmation, and cancellation.
		const selectListInput = matchesKey(data, "j")
			? SELECT_LIST_DOWN_INPUT
			: matchesKey(data, "k")
				? SELECT_LIST_UP_INPUT
				: data;
		this.#selectList?.handleInput(selectListInput);
		this.#tui.requestRender();
	}

	invalidate(): void {
		this.#selectList?.invalidate();
	}

	render(width: number): string[] {
		this.#synchronizeListHeight();
		const innerWidth = Math.max(1, width - 2);
		const contentWidth = Math.max(1, innerWidth - MINIMUM_INNER_MARGIN * 2);
		const border = (text: string) => this.#theme.fg("border", text);
		const contentLines = [
			...this.#renderSectionedList(contentWidth),
			this.#theme.fg(
				"dim",
				"↑/k ↓/j navigate · →/l children · ←/h parent · Enter switch · Esc close",
			),
		];
		const blockWidth = Math.min(
			contentWidth,
			Math.max(1, ...contentLines.map((line) => visibleWidth(line))),
		);
		const leftMargin = Math.floor((innerWidth - blockWidth) / 2);
		const rightMargin = innerWidth - blockWidth - leftMargin;
		return [
			border(`┌${"─".repeat(innerWidth)}┐`),
			...contentLines.map((line) => {
				const content = truncateToWidth(line, blockWidth, "");
				const contentPadding = " ".repeat(blockWidth - visibleWidth(content));
				return `${border("│")}${" ".repeat(leftMargin)}${content}${contentPadding}${" ".repeat(rightMargin)}${border("│")}`;
			}),
			border(`└${"─".repeat(innerWidth)}┘`),
		];
	}

	#synchronizeListHeight(): void {
		const terminalRows = this.#tui.terminal.rows;
		const overlayRows = Math.max(1, terminalRows - OVERLAY_MARGIN * 2);
		const hasAttention = this.#items.some(({ kind }) => kind === "attention");
		const chromeRows =
			BASE_OVERLAY_CHROME_ROWS +
			OWNER_SECTION_ROWS +
			FOCUSED_DETAIL_ROWS +
			(hasAttention ? ATTENTION_SECTION_ROWS : 0);
		const availableRows = Math.max(
			1,
			overlayRows - chromeRows - SCROLL_INDICATOR_ROWS,
		);
		const visibleRows = Math.max(
			1,
			Math.min(this.#items.length || 1, MAX_VISIBLE_AGENT_ROWS, availableRows),
		);
		if (visibleRows === this.#visibleRows) return;

		this.#visibleRows = visibleRows;

		const list = new SelectList(
			this.#items,
			visibleRows,
			this.#selectListTheme(),
		);
		list.setSelectedIndex(this.#selectedIndex);
		list.onSelectionChange = (item) => {
			const selectedIndex = this.#items.indexOf(item as AgentSelectorItem);
			if (selectedIndex >= 0) this.#selectedIndex = selectedIndex;
		};
		list.onSelect = ({ value }) => this.#done(value);
		list.onCancel = () => this.#done(undefined);
		this.#selectList = list;
	}

	#renderSectionedList(width: number): string[] {
		const listLines = this.#selectList?.render(width) ?? [];
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
		const itemLines = listLines.slice(0, itemLineCount);
		const trailingLines = listLines.slice(itemLineCount);
		const sectionedLines: string[] = [];
		let previousKind: "attention" | "owner" | "agent" | undefined;

		for (let offset = 0; offset < itemLines.length; offset += 1) {
			const item = this.#items[startIndex + offset];
			if (!item) continue;
			const kind =
				item.kind === "attention"
					? "attention"
					: item.value === this.#ownerItem().value
						? "owner"
						: "agent";
			if (kind !== previousKind) {
				const title =
					kind === "attention"
						? "Attention Inbox"
						: kind === "owner"
							? "Owner"
							: this.#scopeTitle(width);
				sectionedLines.push(this.#theme.fg("toolTitle", this.#theme.bold(title)));
				previousKind = kind;
			}
			sectionedLines.push(itemLines[offset] ?? "");
			if (startIndex + offset === this.#selectedIndex) {
				sectionedLines.push(...this.#focusedDetailLines(item, width));
			}
		}

		return [...sectionedLines, ...trailingLines];
	}

	#focusedDetailLines(item: AgentSelectorItem, width: number): [string, string] {
		if (!item.detailLines) return ["", ""];
		const [identityAndDescription, runtime] = item.detailLines;
		return [
			this.#theme.fg(
				"muted",
				truncateToWidth(`  ${identityAndDescription}`, width, ""),
			),
			this.#theme.fg("dim", truncateToWidth(`  ${runtime}`, width, "")),
		];
	}

	#rebuildItems(preferredKind: "attention" | "agent", preferredValue: string): void {
		this.#items = [
			...this.#attentionItems,
			this.#withChildCount(this.#ownerItem()),
			...this.#scopedAgentItems().map((item) => this.#withChildCount(item)),
		];
		const preferredIndex = this.#items.findIndex(
			({ kind, value }) =>
				(kind === "attention" ? "attention" : "agent") === preferredKind &&
				value === preferredValue,
		);
		this.#selectedIndex = Math.max(0, preferredIndex);
		this.#visibleRows = 0;
		this.#selectList = undefined;
		this.#synchronizeListHeight();
	}

	#scopedAgentItems(): AgentSelectorItem[] {
		const scope = this.#agentItems.find(({ value }) => value === this.#scopeValue);
		if (!scope) throw new Error(`Agent scope is absent from roster: ${this.#scopeValue}`);
		return this.#agentItems.filter(({ parentValue }) => parentValue === this.#scopeValue);
	}

	#ownerItem(): AgentSelectorItem {
		const owner = this.#agentItems.find(({ parentValue }) => parentValue === undefined);
		if (!owner) throw new Error("Agent roster has no Owner");
		return owner;
	}

	#withChildCount(item: AgentSelectorItem): AgentSelectorItem {
		const childCount = this.#agentItems.filter(
			({ parentValue }) => parentValue === item.value,
		).length;
		if (childCount === 0) return item;
		const childLabel = childCount === 1 ? "1 child" : `${childCount} children`;
		return {
			...item,
			description: `${item.description ?? ""} · ${childLabel} ›`,
		};
	}

	#zoomIn(): void {
		const selected = this.#items[this.#selectedIndex];
		if (!selected || selected.kind === "attention") return;
		const firstChild = this.#agentItems.find(
			({ parentValue }) => parentValue === selected.value,
		);
		if (!firstChild) return;
		this.#scopeValue = selected.value;
		this.#rebuildItems("agent", firstChild.value);
	}

	#zoomOut(): void {
		const scope = this.#agentItems.find(({ value }) => value === this.#scopeValue);
		if (!scope?.parentValue) return;
		const previousScopeValue = this.#scopeValue;
		this.#scopeValue = scope.parentValue;
		this.#rebuildItems("agent", previousScopeValue);
	}

	#scopeTitle(width: number): string {
		const labels: string[] = [];
		let current = this.#agentItems.find(({ value }) => value === this.#scopeValue);
		while (current?.parentValue) {
			labels.unshift(current.label);
			const parentValue = current.parentValue;
			current = this.#agentItems.find(({ value }) => value === parentValue);
		}
		if (labels.length === 0) return "Agents";
		const visibleLabels = labels.slice(-MAX_BREADCRUMB_AGENT_SEGMENTS);
		const title = () => {
			const hiddenPrefix = labels.length > visibleLabels.length ? "… / " : "";
			return `Agents / ${hiddenPrefix}${visibleLabels.join(" / ")}`;
		};
		while (visibleLabels.length > 1 && visibleWidth(title()) > width) {
			visibleLabels.shift();
		}
		if (visibleWidth(title()) <= width) return title();

		const prefix = labels.length > 1 ? "Agents / … / " : "Agents / ";
		const leafWidth = Math.max(1, width - visibleWidth(prefix));
		return `${prefix}${truncateToWidth(visibleLabels[0] ?? "", leafWidth, "…")}`;
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
