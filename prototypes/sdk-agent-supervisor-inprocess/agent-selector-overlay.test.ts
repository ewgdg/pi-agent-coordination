import assert from "node:assert/strict";
import test from "node:test";

import type {
	ExtensionUIContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type {
	Component,
	KeybindingsManager,
	TUI,
} from "@earendil-works/pi-tui";

import {
	openAgentSelectorOverlay,
	type AgentSelectorItem,
} from "./agent-selector-overlay.ts";

test("a long Agent roster stays inside a bounded overlay and scrolls from the current Agent", async () => {
	const items: AgentSelectorItem[] = [
		{ kind: "agent", value: "owner", label: "Owner", description: "idle" },
		...Array.from({ length: 19 }, (_, index) => ({
			kind: "agent" as const,
			value: `agent-${index + 1}`,
			label: `Agent ${index + 1}`,
			description: index % 2 === 0 ? "working" : "idle",
			parentValue: "owner",
		})),
	];
	const tui = {
		terminal: { rows: 15 },
		requestRender() {},
	} as unknown as TUI;
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as Theme;
	let component: Component | undefined;
	let overlayOptions:
		| { overlay?: boolean; overlayOptions?: { width?: number | string } }
		| undefined;
	const ui = {
		custom<T>(
			factory: (
				tui: TUI,
				theme: Theme,
				keybindings: KeybindingsManager,
				done: (result: T) => void,
			) => Component,
			options: { overlay?: boolean; overlayOptions?: { width?: number | string } },
		): Promise<T> {
			overlayOptions = options;
			return new Promise<T>((resolve) => {
				component = factory(
					tui,
					theme,
					{} as KeybindingsManager,
					resolve,
				);
			});
		},
	} as unknown as ExtensionUIContext;

	const selection = openAgentSelectorOverlay(ui, items, "agent-10");
	await Promise.resolve();

	assert.equal(overlayOptions?.overlay, true);
	assert.equal(overlayOptions?.overlayOptions?.width, 80);
	assert.ok(component);
	const rendered = component.render(120);
	assert.ok(rendered.length <= 13, `rendered ${rendered.length} rows in a 15-row terminal`);
	assert.match(rendered.join("\n"), /Agent 10/);
	assert.match(rendered.join("\n"), /\(11\/20\)/);
	const selectedRow = rendered.find((line) => line.includes("Agent 10"));
	assert.match(selectedRow ?? "", /^│ +→/);
	assert.match(selectedRow ?? "", / │$/);
	assert.match(rendered[0] ?? "", /^┌─+┐$/);
	assert.match(rendered.at(-1) ?? "", /^└─+┘$/);
	assert.match(rendered.join("\n"), /↑\/k ↓\/j navigate/);
	for (const line of rendered.slice(1, -1)) {
		assert.match(line, /^│.*│$/);
	}
	const bodyLines = rendered.slice(1, -1).map((line) => line.slice(1, -1));
	const leftMargin = Math.min(
		...bodyLines.map((line) => line.search(/\S/)).filter((margin) => margin >= 0),
	);
	const rightmostContent = Math.max(...bodyLines.map((line) => line.search(/\s*$/) - 1));
	const rightMargin = (bodyLines[0]?.length ?? 0) - rightmostContent - 1;
	assert.ok(
		Math.abs(leftMargin - rightMargin) <= 1,
		`content margins differ: left ${leftMargin}, right ${rightMargin}`,
	);

	component.handleInput?.("j");
	assert.match(
		component.render(120).find((line) => line.includes("Agent 11")) ?? "",
		/→ Agent 11/,
	);
	component.handleInput?.("k");
	assert.match(
		component.render(120).find((line) => line.includes("Agent 10")) ?? "",
		/→ Agent 10/,
	);
	component.handleInput?.("j");
	component.handleInput?.("\r");
	assert.equal(await selection, "agent-11");
});

test("Attention Inbox entries stay above the roster and switch directly to the requesting Agent", async () => {
	const items: AgentSelectorItem[] = [
		{
			kind: "attention",
			value: "researcher",
			label: "DECIDE · Researcher",
			description: "Which implementation should I use?",
		},
		{ kind: "agent", value: "owner", label: "Owner", description: "idle · selected" },
		{
			kind: "agent",
			value: "researcher",
			label: "Researcher",
			description: "waiting (human)",
			parentValue: "owner",
		},
		{
			kind: "agent",
			value: "builder",
			label: "Builder",
			description: "idle",
			parentValue: "owner",
		},
	];
	const tui = {
		terminal: { rows: 30 },
		requestRender() {},
	} as unknown as TUI;
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as Theme;
	let component: Component | undefined;
	const ui = {
		custom<T>(
			factory: (
				tui: TUI,
				theme: Theme,
				keybindings: KeybindingsManager,
				done: (result: T) => void,
			) => Component,
		): Promise<T> {
			return new Promise<T>((resolve) => {
				component = factory(tui, theme, {} as KeybindingsManager, resolve);
			});
		},
	} as unknown as ExtensionUIContext;

	const selection = openAgentSelectorOverlay(ui, items, "owner");
	await Promise.resolve();
	assert.ok(component);
	const renderedLines = component.render(80);
	const rendered = renderedLines.join("\n");
	assert.doesNotMatch(rendered, /Attention Inbox · Agents/);
	const attentionHeader = renderedLines.findIndex((line) => /Attention Inbox/.test(line));
	const attentionRow = renderedLines.findIndex((line) => /DECIDE · Researcher/.test(line));
	const ownerHeader = renderedLines.findIndex((line) => /│\s+Owner\s+│/.test(line));
	const agentsHeader = renderedLines.findIndex((line) => /│\s+Agents\s+│/.test(line));
	const ownerRow = renderedLines.findIndex((line) => /Owner\s+idle/.test(line));
	assert.ok(attentionHeader < attentionRow);
	assert.ok(attentionRow < ownerHeader);
	assert.ok(ownerHeader < ownerRow);
	assert.ok(ownerRow < agentsHeader);
	assert.equal(agentsHeader, ownerRow + 1);
	assert.match(renderedLines[attentionRow] ?? "", /→ DECIDE · Researcher/);

	component.handleInput?.("\r");
	assert.equal(await selection, "researcher");
});

test("focused Agent details move with the cursor without resizing or changing zoom selection", async () => {
	const items: AgentSelectorItem[] = [
		{
			kind: "agent",
			value: "owner",
			label: "Owner",
			description: "idle",
			detailLines: [
				"owner123 · Workflow owner",
				"codex-lb/gpt-5.6-sol · thinking high · 0 queued",
			],
		},
		{
			kind: "agent",
			value: "researcher",
			label: "Researcher",
			description: "idle",
			parentValue: "owner",
			detailLines: [
				"983c81e3 · Investigates focused questions",
				"codex-lb/gpt-5.6-sol · thinking high · 1 queued",
			],
		},
		{
			kind: "agent",
			value: "source-scout",
			label: "Source Scout",
			description: "working",
			parentValue: "researcher",
		},
		{
			kind: "agent",
			value: "synthesizer",
			label: "Synthesizer",
			description: "idle",
			parentValue: "researcher",
		},
		{
			kind: "agent",
			value: "builder",
			label: "Builder",
			description: "idle",
			parentValue: "owner",
		},
		{
			kind: "agent",
			value: "reviewer",
			label: "Reviewer",
			description: "idle",
			parentValue: "builder",
		},
	];
	const tui = {
		terminal: { rows: 30 },
		requestRender() {},
	} as unknown as TUI;
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as Theme;
	let component: Component | undefined;
	const ui = {
		custom<T>(
			factory: (
				tui: TUI,
				theme: Theme,
				keybindings: KeybindingsManager,
				done: (result: T) => void,
			) => Component,
		): Promise<T> {
			return new Promise<T>((resolve) => {
				component = factory(tui, theme, {} as KeybindingsManager, resolve);
			});
		},
	} as unknown as ExtensionUIContext;

	const selection = openAgentSelectorOverlay(ui, items, "owner");
	await Promise.resolve();
	assert.ok(component);

	const ownerScopeLines = component.render(80);
	const ownerScope = ownerScopeLines.join("\n");
	assert.match(ownerScope, /│\s+Owner\s+│/);
	assert.match(ownerScope, /│\s+Agents\s+│/);
	assert.doesNotMatch(ownerScope, /Agents \/ Owner/);
	assert.match(ownerScope, /owner123 · Workflow owner/);
	assert.doesNotMatch(ownerScope, /↳/);
	assert.match(ownerScope, /codex-lb\/gpt-5\.6-sol · thinking high · 0 queued/);
	assert.doesNotMatch(ownerScope, /983c81e3/);
	assert.match(ownerScope, /Researcher.*2 children/);
	assert.match(ownerScope, /Builder.*1 child/);
	assert.doesNotMatch(ownerScope, /Source Scout|Synthesizer|Reviewer/);

	component.handleInput?.("\x1b[B");
	const researcherFocusLines = component.render(80);
	const researcherFocus = researcherFocusLines.join("\n");
	assert.equal(researcherFocusLines.length, ownerScopeLines.length);
	assert.doesNotMatch(researcherFocus, /owner123/);
	assert.match(researcherFocus, /983c81e3 · Investigates focused questions/);
	assert.doesNotMatch(researcherFocus, /↳/);
	assert.match(researcherFocus, /thinking high · 1 queued/);
	const researcherRow = researcherFocusLines.findIndex((line) => /→ Researcher/.test(line));
	const researcherDetail = researcherFocusLines.findIndex((line) => /983c81e3/.test(line));
	assert.equal(researcherDetail, researcherRow + 1);
	assert.equal(
		researcherFocusLines[researcherRow]?.indexOf("Researcher"),
		researcherFocusLines[researcherDetail]?.indexOf("983c81e3"),
	);
	assert.equal(
		researcherFocusLines[researcherDetail]?.indexOf("983c81e3"),
		researcherFocusLines[researcherDetail + 1]?.indexOf("codex-lb"),
	);

	component.handleInput?.("\x1b[C");
	const researcherScope = component.render(80).join("\n");
	assert.match(researcherScope, /│\s+Owner\s+│/);
	assert.match(researcherScope, /Agents \/ Researcher/);
	assert.doesNotMatch(researcherScope, /Agents \/ Owner/);
	assert.doesNotMatch(researcherScope, /Researcher\s+idle/);
	assert.match(researcherScope, /Source Scout/);
	assert.match(researcherScope, /Synthesizer/);
	assert.doesNotMatch(researcherScope, /Builder|Reviewer/);
	assert.match(
		component.render(80).find((line) => line.includes("Source Scout")) ?? "",
		/→ Source Scout/,
	);

	component.handleInput?.("\x1b[D");
	assert.match(
		component.render(80).find((line) => line.includes("Researcher")) ?? "",
		/→ Researcher/,
	);
	component.handleInput?.("\r");
	assert.equal(await selection, "researcher");
});

test("the breadcrumb omits Owner and keeps only the newest three Agent scopes", async () => {
	const items: AgentSelectorItem[] = [
		{ kind: "agent", value: "owner", label: "Owner", description: "idle" },
		{
			kind: "agent",
			value: "alpha",
			label: "Alpha",
			description: "idle",
			parentValue: "owner",
		},
		{
			kind: "agent",
			value: "beta",
			label: "Beta",
			description: "idle",
			parentValue: "alpha",
		},
		{
			kind: "agent",
			value: "gamma",
			label: "Gamma",
			description: "idle",
			parentValue: "beta",
		},
		{
			kind: "agent",
			value: "delta",
			label: "Delta",
			description: "idle",
			parentValue: "gamma",
		},
		{
			kind: "agent",
			value: "leaf",
			label: "Leaf",
			description: "idle",
			parentValue: "delta",
		},
	];
	const tui = {
		terminal: { rows: 30 },
		requestRender() {},
	} as unknown as TUI;
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as Theme;
	let component: Component | undefined;
	const ui = {
		custom<T>(
			factory: (
				tui: TUI,
				theme: Theme,
				keybindings: KeybindingsManager,
				done: (result: T) => void,
			) => Component,
		): Promise<T> {
			return new Promise<T>((resolve) => {
				component = factory(tui, theme, {} as KeybindingsManager, resolve);
			});
		},
	} as unknown as ExtensionUIContext;

	void openAgentSelectorOverlay(ui, items, "leaf");
	await Promise.resolve();
	assert.ok(component);
	const rendered = component.render(80).join("\n");
	assert.match(rendered, /Agents \/ … \/ Beta \/ Gamma \/ Delta/);
	assert.doesNotMatch(rendered, /Agents \/ Owner|Agents \/ Alpha/);

	const narrowRendered = component.render(30).join("\n");
	assert.match(narrowRendered, /Agents \/ … \/ Gamma \/ Delta/);
	assert.doesNotMatch(narrowRendered, /Beta/);
});
