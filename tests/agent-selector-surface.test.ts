import assert from "node:assert/strict";
import test from "node:test";

import type {
	ExtensionUIContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type {
	Component,
	TUI,
} from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";

import type {
	AgentRosterStatus,
	AgentStatus,
} from "../src/coordination/workflow-coordinator.ts";
import { openAgentSelectorSurface } from "../src/presentation/agent-selector-surface.ts";

test("a long Live roster stays bounded and scrolls from the selected Agent", async () => {
	const live = [
		agentStatus("owner", "Owner", null),
		...Array.from({ length: 19 }, (_, index) =>
			agentStatus(`agent-${index + 1}`, `Agent ${index + 1}`, "owner")
		),
	];
	const tui = {
		terminal: { rows: 15 },
		requestRender() {},
	} as unknown as TUI;
	const theme = plainTheme();
	let component: Component | undefined;
	let overlayOptions: unknown;
	const ui = {
		custom<T>(
			factory: (
				tui: TUI,
				theme: Theme,
				keybindings: KeybindingsManager,
				done: (result: T) => void,
			) => Component,
			options: unknown,
		): Promise<T> {
			overlayOptions = options;
			return new Promise<T>((resolve) => {
				component = factory(tui, theme, {} as KeybindingsManager, resolve);
			});
		},
	} as unknown as ExtensionUIContext;

	const selection = openAgentSelectorSurface(ui, {
		live,
		dormant: [],
		selectedAgentId: "agent-10",
	});
	await Promise.resolve();

	assert.deepEqual(overlayOptions, {
		overlay: true,
		overlayOptions: {
			width: 80,
			maxHeight: "90%",
			anchor: "center",
			margin: 1,
		},
	});
	assert.ok(component);
	const rendered = component.render(120);
	assert.ok(rendered.length <= 13, `rendered ${rendered.length} rows in a 15-row terminal`);
	assert.ok(rendered.every((line) => visibleWidth(line) <= 80));
	assert.match(rendered.join("\n"), /Agent 10/);
	assert.match(rendered.join("\n"), /\(11\/20\)/);
	assert.match(rendered.find((line) => line.includes("Agent 10")) ?? "", /→ Agent 10/);
	assert.match(rendered[0] ?? "", /^┌─+┐$/);
	assert.match(rendered.at(-1) ?? "", /^└─+┘$/);

	component.handleInput?.("j");
	assert.match(
		component.render(120).find((line) => line.includes("Agent 11")) ?? "",
		/→ Agent 11/,
	);
	component.handleInput?.("\x1b[A");
	assert.match(
		component.render(120).find((line) => line.includes("Agent 10")) ?? "",
		/→ Agent 10/,
	);
	component.handleInput?.("\x1b[B");
	assert.match(
		component.render(120).find((line) => line.includes("Agent 11")) ?? "",
		/→ Agent 11/,
	);
	component.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

test("Live remains terminal-bounded across Attention, Owner, and Agent sections", async () => {
	const harness = surfaceHarness(24);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [
			agentStatus("owner", "Owner", null),
			...Array.from({ length: 20 }, (_, index) =>
				agentStatus(`agent-${index + 1}`, `Agent ${index + 1}`, "owner")
			),
		],
		dormant: [],
		selectedAgentId: "owner",
		humanAttention: [{
			requestId: "human-request-id",
			agentId: "agent-1",
			agentLabel: "Agent 1",
			questionCount: 1,
		}],
	});
	await Promise.resolve();
	assert.ok(harness.component);

	const rendered = harness.component.render(80);
	assert.match(rendered.join("\n"), /Attention Inbox/);
	assert.match(rendered.join("\n"), /│\s+Owner\s+│/);
	assert.match(rendered.join("\n"), /│\s+Agents\s+│/);
	assert.ok(rendered.length <= 21, `rendered ${rendered.length} rows in a 24-row terminal`);
	for (let move = 0; move < 10; move += 1) harness.component.handleInput?.("j");
	assert.equal(harness.component.render(80).length, rendered.length);
	harness.component.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

test("a short terminal keeps both frame edges inside Pi's overlay height", async () => {
	const harness = surfaceHarness(10);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null)],
		dormant: [],
		selectedAgentId: "owner",
	});
	await Promise.resolve();
	assert.ok(harness.component);

	const rendered = harness.component.render(80);
	assert.ok(rendered.length <= 8, `rendered ${rendered.length} rows in a 10-row terminal`);
	assert.match(rendered[0] ?? "", /^┌─+┐$/);
	assert.match(rendered.at(-1) ?? "", /^└─+┘$/);
	harness.component.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

test("Live and Dormant are explicit keyboard-accessible tabs", async () => {
	const harness = surfaceHarness(30);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null)],
		dormant: [
			dormantAgentStatus("recent", "Recent", "owner"),
			dormantAgentStatus("older", "Older", "owner"),
		],
		selectedAgentId: "owner",
	});
	await Promise.resolve();
	assert.ok(harness.component);

	assert.match(harness.component.render(80).join("\n"), /\[ Live \].*Dormant/);
	harness.component.handleInput?.("\t");
	const dormant = harness.component.render(80).join("\n");
	assert.match(dormant, /Live.*\[ Dormant \]/);
	assert.match(dormant, /Recent/);
	assert.match(dormant, /Older/);
	assert.doesNotMatch(dormant, /→ Owner/);

	harness.component.handleInput?.("\x1b[Z");
	assert.match(harness.component.render(80).join("\n"), /\[ Live \].*Dormant/);
	harness.component.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

test("Live shows direct children and navigates Agent scopes", async () => {
	const harness = surfaceHarness(30);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [
			agentStatus("owner", "Owner", null),
			agentStatus("researcher", "Researcher", "owner"),
			agentStatus("source-scout", "Source Scout", "researcher"),
			agentStatus("synthesizer", "Synthesizer", "researcher"),
			agentStatus("builder", "Builder", "owner"),
			agentStatus("reviewer", "Reviewer", "builder"),
		],
		dormant: [],
		selectedAgentId: "owner",
	});
	await Promise.resolve();
	assert.ok(harness.component);

	const ownerScope = harness.component.render(80).join("\n");
	assert.match(ownerScope, /Owner/);
	assert.match(ownerScope, /Researcher.*2 children/);
	assert.match(ownerScope, /Builder.*1 child/);
	assert.doesNotMatch(ownerScope, /Source Scout|Synthesizer|Reviewer/);

	harness.component.handleInput?.("j");
	harness.component.handleInput?.("l");
	const researcherScope = harness.component.render(80).join("\n");
	assert.match(researcherScope, /Agents \/ Researcher/);
	assert.match(researcherScope, /Source Scout/);
	assert.match(researcherScope, /Synthesizer/);
	assert.doesNotMatch(researcherScope, /Builder|Reviewer/);
	assert.match(
		harness.component.render(80).find((line) => line.includes("Source Scout")) ?? "",
		/→ Source Scout/,
	);

	harness.component.handleInput?.("h");
	assert.match(
		harness.component.render(80).find((line) => line.includes("Researcher")) ?? "",
		/→ Researcher/,
	);
	harness.component.handleInput?.("\x1b[C");
	assert.match(harness.component.render(80).join("\n"), /Agents \/ Researcher/);
	harness.component.handleInput?.("\x1b[D");
	assert.match(
		harness.component.render(80).find((line) => line.includes("Researcher")) ?? "",
		/→ Researcher/,
	);
	harness.component.handleInput?.("\r");
	assert.deepEqual(await selection, { kind: "select_agent", agentId: "researcher" });
});

test("focused Agent details use a stable four-row budget", async () => {
	const harness = surfaceHarness(30);
	const owner = selectorAgent({
		...agentStatus("owner-full-identity", "Owner", null),
		workflowId: "owner-full-identity",
		run: {
			phase: "live",
			work: "settled",
			attention: "none",
			retentionReasons: [
				{ reason: "owner_host_binding", count: 1 },
				{ reason: "interactive_selection", count: 1 },
			],
		},
	}, "owner-provider", "owner-model", "high", 0);
	const researcher = selectorAgent({
		...agentStatus("researcher-full-identity", "Researcher", "owner-full-identity"),
		workflowId: "owner-full-identity",
		description: "Investigates focused questions",
		run: {
			phase: "live",
			work: "settled",
			attention: "input_required",
			retentionReasons: [{ reason: "answer_owed", count: 2 }],
		},
	}, "research-provider", "research-model", "medium", 1);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [owner, researcher],
		dormant: [],
		selectedAgentId: owner.agentId,
	});
	await Promise.resolve();
	assert.ok(harness.component);

	const ownerLines = harness.component.render(80);
	const ownerRendered = ownerLines.join("\n");
	assert.match(ownerRendered, /owner-full-identity/);
	assert.match(
		ownerRendered,
		/Live · settled · Retention owner host binding, interactive selection/,
	);
	assert.match(ownerRendered, /owner-provider\/owner-model · thinking high · 0 queued/);
	assert.doesNotMatch(ownerRendered, /description unavailable|no description/i);

	harness.component.handleInput?.("j");
	const researcherLines = harness.component.render(80);
	const researcherRendered = researcherLines.join("\n");
	assert.equal(researcherLines.length, ownerLines.length);
	assert.match(researcherRendered, /Investigates focused questions/);
	assert.match(researcherRendered, /researcher-full-identity/);
	assert.match(
		researcherRendered,
		/Live · settled · input required · Retention answer owed ×2/,
	);
	assert.match(
		researcherRendered,
		/research-provider\/research-model · thinking medium · 1 queued/,
	);
	harness.component.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

test("the selector uses fixed one-cell horizontal padding", async () => {
	const harness = surfaceHarness(30);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null)],
		dormant: [],
		selectedAgentId: "owner",
	});
	await Promise.resolve();
	assert.ok(harness.component);

	const tabs = harness.component.render(80).find((line) => line.includes("Live"));
	assert.ok(tabs);
	assert.equal(tabs.slice(1).search(/\S/u), 1);
	harness.component.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

test("long focused descriptions do not change horizontal padding", async () => {
	const harness = surfaceHarness(30);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null)],
		dormant: [
			{
				...dormantAgentStatus("short", "Short", "owner"),
				description: "Short description",
			},
			{
				...dormantAgentStatus("long", "Long", "owner"),
				description:
					"A particularly long description that previously changed the padding of every row",
			},
		],
		selectedAgentId: "owner",
	});
	await Promise.resolve();
	assert.ok(harness.component);
	harness.component.handleInput?.("\t");

	const shortDescriptionLines = harness.component.render(80);
	const shortTabs = shortDescriptionLines.find((line) => line.includes("Live"));
	assert.ok(shortTabs);
	harness.component.handleInput?.("j");
	const longDescriptionLines = harness.component.render(80);
	const longTabs = longDescriptionLines.find((line) => line.includes("Live"));
	assert.ok(longTabs);

	assert.equal(longTabs.indexOf("Live"), shortTabs.indexOf("Live"));
	harness.component.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

test("Dormant Moderator rows show role and trigger while Enter delegates selection", async () => {
	const harness = surfaceHarness(30);
	const moderator = selectorAgent({
		...dormantAgentStatus("moderator-id", "moderator", null),
		description: "obligation stall",
	}, "moderator-provider", "moderator-model", "high", 0);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null)],
		dormant: [moderator],
		selectedAgentId: "owner",
	});
	await Promise.resolve();
	assert.ok(harness.component);
	harness.component.handleInput?.("\t");

	const rendered = harness.component.render(80);
	const moderatorRow = rendered.find((line) => line.includes("moderator"));
	assert.match(moderatorRow ?? "", /Moderator/);
	assert.match(moderatorRow ?? "", /obligation stall/);
	assert.match(rendered.join("\n"), /moderator-id/);
	harness.component.handleInput?.("\r");
	assert.deepEqual(await selection, {
		kind: "select_agent",
		agentId: "moderator-id",
	});
});

test("Live uses one attention-first list and dispatches the exact Human Request", async () => {
	const harness = surfaceHarness(30);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [
			agentStatus("owner", "Owner", null),
			agentStatus("researcher", "Researcher", "owner"),
		],
		dormant: [],
		selectedAgentId: "owner",
		humanAttention: [{
			requestId: "human-request-id",
			agentId: "researcher",
			agentLabel: "Researcher",
			questionCount: 2,
		}],
		operationalAttention: [],
	});
	await Promise.resolve();
	assert.ok(harness.component);

	const lines = harness.component.render(80);
	const attentionHeader = lines.findIndex((line) => line.includes("Attention Inbox"));
	const decideRow = lines.findIndex((line) => line.includes("DECIDE 1"));
	const ownerHeader = lines.findIndex((line) => /│\s+Owner\s+│/.test(line));
	const ownerRow = lines.findIndex((line) => /→?\s*Owner\s+live/.test(line));
	const agentsHeader = lines.findIndex((line) => /│\s+Agents\s+│/.test(line));
	assert.ok(attentionHeader < decideRow);
	assert.ok(decideRow < ownerHeader);
	assert.ok(ownerHeader < ownerRow);
	assert.ok(ownerRow < agentsHeader);
	assert.match(lines[decideRow] ?? "", /→ DECIDE 1/);

	harness.component.handleInput?.("\r");
	assert.deepEqual(await selection, {
		kind: "focus_human_request",
		requestId: "human-request-id",
	});
});

test("Operational ATTENTION is focusable and passive", async () => {
	const harness = surfaceHarness(30);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null)],
		dormant: [],
		selectedAgentId: "owner",
		operationalAttention: [{
			trigger: {
				kind: "run_failure",
				agentId: "affected-agent",
				runSequence: 2,
				obligations: {
					total: 1,
					sources: [{
						agentId: "requester-agent",
						entryId: "request-entry",
						toolCallId: "request-call",
					}],
				},
			},
			affectedAgentIds: ["affected-agent"],
			diagnostics: [{ agentId: "moderator", entryId: "diagnostic-entry" }],
		}],
	});
	await Promise.resolve();
	assert.ok(harness.component);

	const rendered = harness.component.render(80).join("\n");
	assert.match(rendered, /→ ATTENTION 1 · Run Failure/);
	assert.match(rendered, /Request requester-agent\/request-entry\/request-call/);
	harness.component.handleInput?.("\r");
	assert.equal(harness.resolved, false);
	harness.component.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

test("Live breadcrumbs omit Owner and keep the newest three Agent scopes", async () => {
	const harness = surfaceHarness(30);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [
			agentStatus("owner", "Owner", null),
			agentStatus("alpha", "Alpha", "owner"),
			agentStatus("beta", "Beta", "alpha"),
			agentStatus("gamma", "Gamma", "beta"),
			agentStatus("delta", "Delta", "gamma"),
			agentStatus("leaf", "Leaf", "delta"),
		],
		dormant: [],
		selectedAgentId: "leaf",
	});
	await Promise.resolve();
	assert.ok(harness.component);

	const rendered = harness.component.render(80).join("\n");
	assert.match(rendered, /Agents \/ … \/ Beta \/ Gamma \/ Delta/);
	assert.doesNotMatch(rendered, /Agents \/ Owner|Agents \/ Alpha/);
	const narrow = harness.component.render(30).join("\n");
	assert.match(narrow, /Agents \/ … \/ Gamma \/ Delta/);
	assert.doesNotMatch(narrow, /Beta/);
	const veryNarrow = harness.component.render(15);
	assert.match(veryNarrow.join("\n"), /Delta/);
	assert.ok(veryNarrow.every((line) => visibleWidth(line) <= 15));
	harness.component.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

function agentStatus(
	agentId: string,
	label: string,
	directSpawnerAgentId: string | null,
): AgentRosterStatus {
	return {
		agentId,
		workflowId: "owner",
		label,
		directSpawnerAgentId,
		primaryEvidence: {
			transcriptPath: null,
			inspectedThrough: { agentId, entryId: `entry-${agentId}` },
		},
		run: {
			phase: "live",
			work: "settled",
			attention: "none",
			retentionReasons: [],
		},
		model: { provider: "test-provider", modelId: "test-model" },
		thinking: "off",
		queuedInputCount: 0,
	};
}

function dormantAgentStatus(
	agentId: string,
	label: string,
	directSpawnerAgentId: string | null,
): AgentRosterStatus {
	return {
		...agentStatus(agentId, label, directSpawnerAgentId),
		run: { phase: "dormant", retentionReasons: [] },
	};
}

function selectorAgent<T extends AgentRosterStatus>(
	status: T,
	provider: string,
	modelId: string,
	thinking: string,
	queuedInputCount: number,
): T & {
	model: { provider: string; modelId: string };
	thinking: string;
	queuedInputCount: number;
} {
	return {
		...status,
		model: { provider, modelId },
		thinking,
		queuedInputCount,
	};
}

function surfaceHarness(terminalRows: number): {
	ui: ExtensionUIContext;
	component: Component | undefined;
	resolved: boolean;
} {
	const harness: { component: Component | undefined; resolved: boolean } = {
		component: undefined,
		resolved: false,
	};
	const tui = {
		terminal: { rows: terminalRows },
		requestRender() {},
	} as unknown as TUI;
	const theme = {
		...plainTheme(),
		bg: (_color: string, text: string) => `[${text}]`,
	} as Theme;
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
				harness.component = factory(
					tui,
					theme,
					{} as KeybindingsManager,
					(result) => {
						harness.resolved = true;
						resolve(result);
					},
				);
			});
		},
	} as unknown as ExtensionUIContext;
	return {
		ui,
		get component() {
			return harness.component;
		},
		get resolved() {
			return harness.resolved;
		},
	};
}

function plainTheme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as Theme;
}
