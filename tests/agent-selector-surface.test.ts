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
import { type AgentSelectorOptions, openAgentSelectorSurface } from "../src/presentation/agent-selector-surface.ts";

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
			width: "100%",
			maxHeight: "100%",
			anchor: "top-left",
		},
	});
	assert.ok(component);
	const rendered = renderPanel(component, 120);
	assert.ok(rendered.length <= 13, `rendered ${rendered.length} rows in a 15-row terminal`);
	assert.ok(rendered.every((line) => visibleWidth(line) <= 80));
	assert.match(rendered.join("\n"), /Agent 10/);
	assert.match(rendered.join("\n"), /\(11\/20\)/);
	assert.match(rendered.find((line) => line.includes("Agent 10")) ?? "", /→ Agent 10/);
	assert.match(rendered[0] ?? "", /^┌─+┐$/);
	assert.match(rendered.at(-1) ?? "", /^└─+┘$/);

	component.handleInput?.("j");
	assert.match(
		renderPanel(component, 120).find((line) => line.includes("Agent 11")) ?? "",
		/→ Agent 11/,
	);
	component.handleInput?.("\x1b[A");
	assert.match(
		renderPanel(component, 120).find((line) => line.includes("Agent 10")) ?? "",
		/→ Agent 10/,
	);
	component.handleInput?.("\x1b[B");
	assert.match(
		renderPanel(component, 120).find((line) => line.includes("Agent 11")) ?? "",
		/→ Agent 11/,
	);
	component.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

test("Live remains terminal-bounded across Attention and Agent sections", async () => {
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
			question: "Choose the implementation boundary.",
		}],
	});
	await Promise.resolve();
	assert.ok(harness.component);

	const rendered = renderPanel(harness.component, 80);
	assert.match(rendered.join("\n"), /Attention Inbox/);
	assert.match(rendered.join("\n"), /\[Owner\]\[›\]/);
	assert.doesNotMatch(rendered.join("\n"), /│\s+Owner\s+│/);
	assert.match(rendered.join("\n"), /o Owner · Tab views/);
	assert.ok(rendered.length <= 21, `rendered ${rendered.length} rows in a 24-row terminal`);
	for (let move = 0; move < 10; move += 1) harness.component.handleInput?.("j");
	assert.equal(renderPanel(harness.component, 80).length, rendered.length);
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

	const rendered = renderPanel(harness.component, 80);
	assert.ok(rendered.length <= 8, `rendered ${rendered.length} rows in a 10-row terminal`);
	assert.match(rendered[0] ?? "", /^┌─+┐$/);
	assert.match(rendered.at(-1) ?? "", /^└─+┘$/);
	assert.match(rendered.join("\n"), /Agents/);
	assert.match(rendered.join("\n"), /No live Agents/);
	harness.component.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

test("Agent selection keeps the selector focused until view preparation completes", async () => {
	const harness = surfaceHarness(24);
	let releasePreparation!: () => void;
	const preparation = new Promise<void>((resolve) => {
		releasePreparation = resolve;
	});
	let preparedAgentId: string | undefined;
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [
			agentStatus("owner", "Owner", null),
			agentStatus("agent", "Agent", "owner"),
		],
		dormant: [],
		selectedAgentId: "agent",
		async prepareSelection(action) {
			assert.equal(action.kind, "select_agent");
			if (action.kind !== "select_agent") return;
			preparedAgentId = action.agentId;
			await preparation;
		},
	});
	await Promise.resolve();
	assert.ok(harness.component);

	const idleAgentRow =
		renderPanel(harness.component, 80).find((line) => line.includes("→ Agent")) ?? "";
	assert.match(idleAgentRow, /→ Agent/);
	harness.component.handleInput?.("\r");
	await Promise.resolve();
	assert.equal(preparedAgentId, "agent");
	assert.equal(harness.resolved, false);
	const pendingAgentRow =
		renderPanel(harness.component, 80).find((line) => line.includes("→")) ?? "";
	assert.match(pendingAgentRow, /→ Agent\s+⠋ loading/);
	assert.equal(pendingAgentRow.indexOf("Agent"), idleAgentRow.indexOf("Agent"));
	assert.doesNotMatch(pendingAgentRow, /live\/settled/);
	await waitFor(() =>
		!/→ Agent\s+⠋ loading/.test(
			renderPanel(harness.component, 80).find((line) => line.includes("→")) ?? "",
		)
	);
	// Input remains captured by the selector during the asynchronous handoff.
	harness.component.handleInput?.("escape");
	assert.equal(harness.resolved, false);

	releasePreparation();
	assert.deepEqual(await selection, {
		kind: "select_agent",
		agentId: "agent",
	});
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

	assert.match(renderPanel(harness.component, 80).join("\n"), /\[ Live \].*Dormant/);
	harness.component.handleInput?.("\t");
	const dormant = renderPanel(harness.component, 80).join("\n");
	assert.match(dormant, /Live.*\[ Dormant \]/);
	assert.match(dormant, /Recent/);
	assert.match(dormant, /Older/);
	assert.doesNotMatch(dormant, /→ Owner/);

	harness.component.handleInput?.("\x1b[Z");
	assert.match(renderPanel(harness.component, 80).join("\n"), /\[ Live \].*Dormant/);
	harness.component.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

test("o returns to Owner from the flat Dormant roster", async () => {
	const harness = surfaceHarness(30);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [
			agentStatus("owner", "Owner", null),
			agentStatus("live", "Live Agent", "owner"),
		],
		dormant: [dormantAgentStatus("dormant", "Dormant Agent", "owner")],
		selectedAgentId: "dormant",
	});
	await Promise.resolve();
	assert.ok(harness.component);

	const dormant = renderPanel(harness.component, 80).join("\n");
	assert.match(dormant, /\[ Dormant \]/);
	assert.match(dormant, /→ Dormant Agent/);
	assert.doesNotMatch(dormant, /→ Owner/);
	harness.component.handleInput?.("o");
	assert.deepEqual(await selection, { kind: "select_agent", agentId: "owner" });
});

test("reopening preserves the selected Dormant Agent", async () => {
	const harness = surfaceHarness(30);
	const firstSelection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null)],
		dormant: [
			dormantAgentStatus("recent", "Recent", "owner"),
			dormantAgentStatus("selected", "Selected", "owner"),
		],
		selectedAgentId: "owner",
	});
	await Promise.resolve();
	assert.ok(harness.component);

	harness.component.handleInput?.("\t");
	harness.component.handleInput?.("j");
	harness.component.handleInput?.("\r");
	const selected = await firstSelection;
	assert.deepEqual(selected, { kind: "select_agent", agentId: "selected" });
	if (!selected || selected.kind !== "select_agent") throw new Error("selection missing");

	const reopened = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null)],
		dormant: [
			dormantAgentStatus("recent", "Recent", "owner"),
			dormantAgentStatus("selected", "Selected", "owner"),
		],
		selectedAgentId: selected.agentId,
	});
	await Promise.resolve();
	assert.ok(harness.component);

	const rendered = renderPanel(harness.component, 80).join("\n");
	assert.match(rendered, /Live.*\[ Dormant \]/);
	assert.match(rendered, /→ Selected/);
	harness.component.handleInput?.("\x1b");
	assert.equal(await reopened, undefined);
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

	const ownerScope = renderPanel(harness.component, 80).join("\n");
	assert.doesNotMatch(ownerScope, /→?\s*Owner\s+live/);
	assert.match(ownerScope, /Researcher.*2 children/);
	assert.match(ownerScope, /Builder.*1 child/);
	assert.doesNotMatch(ownerScope, /Source Scout|Synthesizer|Reviewer/);

	harness.component.handleInput?.("l");
	const researcherScope = renderPanel(harness.component, 80).join("\n");
	assert.match(researcherScope, /\[Owner\]\[›\] Researcher/);
	assert.match(researcherScope, /Source Scout/);
	assert.match(researcherScope, /Synthesizer/);
	assert.doesNotMatch(researcherScope, /Builder|Reviewer/);
	assert.match(
		renderPanel(harness.component, 80).find((line) => line.includes("Source Scout")) ?? "",
		/→ Source Scout/,
	);

	harness.component.handleInput?.("h");
	assert.match(
		renderPanel(harness.component, 80).find((line) => line.includes("Researcher")) ?? "",
		/→ Researcher/,
	);
	harness.component.handleInput?.("\x1b[C");
	assert.match(renderPanel(harness.component, 80).join("\n"), /\[Owner\]\[›\] Researcher/);
	harness.component.handleInput?.("\x1b[D");
	assert.match(
		renderPanel(harness.component, 80).find((line) => line.includes("Researcher")) ?? "",
		/→ Researcher/,
	);
	harness.component.handleInput?.("\r");
	assert.deepEqual(await selection, { kind: "select_agent", agentId: "researcher" });
});

test("Agent rows show the human-facing work status", async () => {
	const harness = surfaceHarness(30);
	const waitingAgent = {
		...agentStatus("waiting-agent", "Waiting Agent", "owner"),
		run: {
			phase: "live" as const,
			work: "active" as const,
			attention: "input_required" as const,
			retentionReasons: [],
		},
	};
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null), waitingAgent],
		dormant: [],
		selectedAgentId: "owner",
	});
	await Promise.resolve();
	assert.ok(harness.component);

	const waitingRow = renderPanel(harness.component, 80).find((line) =>
		line.includes("Waiting Agent")
	) ?? "";
	assert.match(waitingRow, /waiting \(human input\)/);
	assert.doesNotMatch(waitingRow, /live\/active/);

	harness.component.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

test("focused Agent details use a stable four-row budget", async () => {
	const harness = surfaceHarness(30);
	const owner = selectorAgent({
		...agentStatus("owner-full-identity", "Owner", null),
		workflowId: "owner-full-identity",
		description: "Workflow Owner",
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
	const builder = selectorAgent({
		...agentStatus("builder-full-identity", "Builder", "owner-full-identity"),
		workflowId: "owner-full-identity",
		description: "Builds the selected design",
	}, "build-provider", "build-model", "low", 0);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [owner, researcher, builder],
		dormant: [],
		selectedAgentId: researcher.agentId,
	});
	await Promise.resolve();
	assert.ok(harness.component);

	const researcherLines = renderPanel(harness.component, 80);
	const researcherRendered = researcherLines.join("\n");
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

	harness.component.handleInput?.("j");
	const builderLines = renderPanel(harness.component, 80);
	assert.equal(builderLines.length, researcherLines.length);
	assert.match(builderLines.join("\n"), /Builds the selected design/);
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

	const tabs = renderPanel(harness.component, 80).find((line) => line.includes("Live"));
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

	const shortDescriptionLines = renderPanel(harness.component, 80);
	const shortTabs = shortDescriptionLines.find((line) => line.includes("Live"));
	assert.ok(shortTabs);
	harness.component.handleInput?.("j");
	const longDescriptionLines = renderPanel(harness.component, 80);
	const longTabs = longDescriptionLines.find((line) => line.includes("Live"));
	assert.ok(longTabs);

	assert.equal(longTabs.indexOf("Live"), shortTabs.indexOf("Live"));
	harness.component.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

test("Dormant Moderator rows show its active role description while Enter delegates selection", async () => {
	const harness = surfaceHarness(30);
	const moderator = selectorAgent({
		...dormantAgentStatus("moderator-id", "moderator", null),
		description: "Moderating obligation stall",
	}, "moderator-provider", "moderator-model", "high", 0);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null)],
		dormant: [moderator],
		selectedAgentId: "owner",
	});
	await Promise.resolve();
	assert.ok(harness.component);
	harness.component.handleInput?.("\t");

	const rendered = renderPanel(harness.component, 80);
	assert.match(rendered.join("\n"), /Moderating obligation stall/);
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
			question: "Which boundary should remain authoritative?",
		}],
		operationalAttention: [],
	});
	await Promise.resolve();
	assert.ok(harness.component);

	const lines = renderPanel(harness.component, 80);
	const attentionHeader = lines.findIndex((line) => line.includes("Attention Inbox"));
	const decideRow = lines.findIndex((line) => line.includes("DECIDE 1"));
	const agentsHeader = lines.findIndex((line) => /\[Owner\]\[›\]/.test(line));
	assert.ok(attentionHeader < decideRow);
	assert.ok(decideRow < agentsHeader);
	assert.doesNotMatch(lines.join("\n"), /→?\s*Owner\s+live/);
	assert.match(lines[decideRow] ?? "", /→ DECIDE 1/);

	harness.component.handleInput?.("\r");
	assert.deepEqual(await selection, {
		kind: "decide",
		requestId: "human-request-id",
		agentId: "researcher",
	});
});

test("single-Agent Operational ATTENTION opens the affected Agent", async () => {
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
			affectedAgents: [{ agentId: "affected-agent", label: "Affected Agent" }],
			diagnostics: [{ agentId: "moderator", entryId: "diagnostic-entry" }],
		}],
	});
	await Promise.resolve();
	assert.ok(harness.component);

	const rendered = renderPanel(harness.component, 80).join("\n");
	assert.match(rendered, /→ ATTENTION 1 · Run Failure · Affected Agent/);
	assert.match(rendered, /Affected Affected Agent/);
	assert.match(rendered, /Request requester-agent\/request-entry\/request-call/);
	harness.component.handleInput?.("\r");
	assert.deepEqual(await selection, {
		kind: "select_agent",
		agentId: "affected-agent",
	});
});

test("multi-Agent Operational ATTENTION keeps the overlay open when Enter has no action", async () => {
	const harness = surfaceHarness(30);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null)],
		dormant: [],
		selectedAgentId: "owner",
		operationalAttention: [{
			trigger: {
				kind: "dependency_deadlock",
				agentIds: ["first-agent", "second-agent"],
				requests: { total: 0, sources: [] },
			},
			affectedAgents: [
				{ agentId: "first-agent", label: "First Agent" },
				{ agentId: "second-agent", label: "Second Agent" },
			],
			diagnostics: [],
		}],
	});
	await Promise.resolve();
	assert.ok(harness.component);

	harness.component.handleInput?.("\r");
	assert.equal(harness.resolved, false);
	assert.match(renderPanel(harness.component, 80).join("\n"), /→ ATTENTION 1 · Dependency Deadl/);
	harness.component.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

test("Live breadcrumbs pin Owner and keep the newest three Agent scopes", async () => {
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

	const rendered = renderPanel(harness.component, 80).join("\n");
	assert.match(rendered, /\[Owner\]\[›\] … \/ Beta \/ Gamma \/ Delta/);
	assert.doesNotMatch(rendered, /\[›\] Owner|\[›\] Alpha/);
	const narrow = renderPanel(harness.component, 30).join("\n");
	assert.match(narrow, /\[Owner\]\[›\] … \/ Delta/);
	assert.doesNotMatch(narrow, /Beta/);
	for (const width of [24, 20]) {
		const veryNarrow = renderPanel(harness.component, width);
		assert.match(veryNarrow.join("\n"), /Delta/);
		assert.ok(veryNarrow.every((line) => visibleWidth(line) <= width));
	}
	const truncatedCurrentScope = renderPanel(harness.component, 19);
	assert.match(truncatedCurrentScope.join("\n"), /\[Owner\]\[›\] Del/);
	assert.doesNotMatch(truncatedCurrentScope.join("\n"), /… \/ /);
	assert.ok(truncatedCurrentScope.every((line) => visibleWidth(line) <= 19));
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
		compacting: false,
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
	compacting: boolean;
	queuedInputCount: number;
} {
	return {
		...status,
		model: { provider, modelId },
		thinking,
		queuedInputCount,
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for selector animation");
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
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

test("an open selector refreshes compaction and restores current work without moving focus", async () => {
 const harness = surfaceHarness(24);
 const owner = agentStatus("owner", "Owner", null);
 const child = agentStatus("child", "Child", "owner");
 let publish!: (snapshot: { live: AgentRosterStatus[]; dormant: AgentRosterStatus[] }) => void;
 let removed = false;
 const selection = openAgentSelectorSurface(harness.ui, {
  live: [owner, child], dormant: [], selectedAgentId: "child",
  addChangeHandler(handler) { publish = handler; return () => { removed = true; }; },
 });
 await Promise.resolve();
 publish({ live: [owner, { ...child, compacting: true }], dormant: [] });
 assert.match(renderPanel(harness.component!, 80).join("\n"), /→ Child.*compacting/);
 publish({ live: [owner, { ...child, compacting: false, run: { phase: "live", work: "active", attention: "none", retentionReasons: [] } }], dormant: [] });
 assert.match(renderPanel(harness.component!, 80).join("\n"), /→ Child.*active/);
 harness.component!.handleInput?.("\x1b");
 await selection;
 (harness.component as Component & { dispose(): void }).dispose();
 assert.equal(removed, true);
});

test("Owner-default focus stays on the resolved child when attention arrives", async () => {
	const harness = surfaceHarness(24);
	const owner = agentStatus("owner", "Owner", null);
	const child = agentStatus("child", "Child", "owner");
	let publish!: Parameters<NonNullable<AgentSelectorOptions["addChangeHandler"]>>[0];
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [owner, child], dormant: [], selectedAgentId: "owner",
		addChangeHandler(handler) { publish = handler; return () => {}; },
	});
	assert.match(renderPanel(harness.component!, 80).join("\n"), /→ Child/);
	publish({
		live: [owner, child], dormant: [],
		humanAttention: [{ requestId: "request", agentId: "child", agentLabel: "Child", question: "Proceed?" }],
	});
	assert.match(renderPanel(harness.component!, 80).join("\n"), /→ Child/);
	harness.component!.handleInput?.("\r");
	assert.deepEqual(await selection, { kind: "select_agent", agentId: "child" });
});

test("a disappeared selection's fallback stays focused on subsequent refreshes", async () => {
	const harness = surfaceHarness(24);
	const owner = agentStatus("owner", "Owner", null);
	const child = agentStatus("child", "Child", "owner");
	const sibling = agentStatus("sibling", "Sibling", "owner");
	let publish!: Parameters<NonNullable<AgentSelectorOptions["addChangeHandler"]>>[0];
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [owner, child, sibling], dormant: [], selectedAgentId: "child",
		addChangeHandler(handler) { publish = handler; return () => {}; },
	});
	publish({ live: [owner, sibling], dormant: [] });
	assert.match(renderPanel(harness.component!, 80).join("\n"), /→ Sibling/);
	publish({ live: [owner, child, sibling], dormant: [] });
	assert.match(renderPanel(harness.component!, 80).join("\n"), /→ Sibling/);
	harness.component!.handleInput?.("\r");
	assert.deepEqual(await selection, { kind: "select_agent", agentId: "sibling" });
});

test("Owner is a pinned button in a linear keyboard focus order", async () => {
	const harness = surfaceHarness(24);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null), agentStatus("child", "Child", "owner")],
		dormant: [], selectedAgentId: "owner",
	});
	const component = harness.component!;
	assert.match(renderPanel(component, 80).join("\n"), /→ Child/);
	component.handleInput?.("j");
	assert.match(renderPanel(component, 80).join("\n"), /→ Child/);
	component.handleInput?.("k");
	assert.match(renderPanel(component, 80).join("\n"), /\[\[Owner\]\]\[›\]/);
	assert.doesNotMatch(renderPanel(component, 80).join("\n"), /→ /);
	component.handleInput?.("\x1b[A");
	component.handleInput?.("\r");
	assert.deepEqual(await selection, { kind: "select_agent", agentId: "owner" });
});

test("Owner child action returns to root and preserves the top-level ancestor", async () => {
	const harness = surfaceHarness(30);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [
			agentStatus("owner", "Owner", null),
			agentStatus("first", "First", "owner"),
			agentStatus("branch", "Branch", "owner"),
			agentStatus("nested", "Nested", "branch"),
			agentStatus("leaf", "Leaf", "nested"),
		], dormant: [], selectedAgentId: "leaf",
	});
	const component = harness.component!;
	component.handleInput?.("k");
	component.handleInput?.("l");
	assert.match(renderPanel(component, 80).join("\n"), /→ Branch/);
	assert.doesNotMatch(renderPanel(component, 80).join("\n"), /\[›\] Nested/);
	component.handleInput?.("k");
	component.handleInput?.("k");
	component.handleInput?.("\x1b[C");
	assert.match(renderPanel(component, 80).join("\n"), /→ First/);
	component.handleInput?.("\r");
	assert.deepEqual(await selection, { kind: "select_agent", agentId: "first" });
});

test("Attention, Owner and Agents form one non-circular order", async () => {
	const harness = surfaceHarness(24);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null), agentStatus("child", "Child", "owner")],
		dormant: [], selectedAgentId: "child",
		humanAttention: [{ requestId: "request", agentId: "child", agentLabel: "Child", question: "Proceed?" }],
	});
	const component = harness.component!;
	for (const key of ["k", "\x1b[A"]) {
		component.handleInput?.(key);
		assert.match(renderPanel(component, 80).join("\n"), /→ DECIDE/);
	}
	component.handleInput?.("j");
	assert.match(renderPanel(component, 80).join("\n"), /\[\[Owner\]\]\[›\]/);
	assert.doesNotMatch(renderPanel(component, 80).join("\n"), /→ /);
	component.handleInput?.("\x1b[B");
	assert.match(renderPanel(component, 80).join("\n"), /→ Child/);
	component.handleInput?.("\x1b[B");
	assert.match(renderPanel(component, 80).join("\n"), /→ Child/);
	component.handleInput?.("k");
	component.handleInput?.("l");
	assert.match(renderPanel(component, 80).join("\n"), /→ Child/);
	component.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

test("Dormant pins Owner without a chevron or heading and Enter selects Owner", async () => {
	const harness = surfaceHarness(24);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null)],
		dormant: [dormantAgentStatus("child", "Child", "owner")], selectedAgentId: "child",
	});
	const component = harness.component!;
	assert.match(renderPanel(component, 80).join("\n"), /→ Child/);
	component.handleInput?.("j");
	assert.match(renderPanel(component, 80).join("\n"), /→ Child/);
	component.handleInput?.("k");
	component.handleInput?.("k");
	component.handleInput?.("l");
	const rendered = renderPanel(component, 80).join("\n");
	assert.match(rendered, /\[\[Owner\]\]/);
	assert.doesNotMatch(rendered, /Dormant Agents|\[›\]|→ /);
	component.handleInput?.("\r");
	assert.deepEqual(await selection, { kind: "select_agent", agentId: "owner" });
});

test("nested Owner path stays visible while scrolling and children remain a trailing action", async () => {
	const harness = surfaceHarness(15);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [
			agentStatus("owner", "Owner", null),
			agentStatus("branch", "Branch", "owner"),
			...Array.from({ length: 20 }, (_, index) => agentStatus("child-" + index, "Child " + index, "branch")),
			agentStatus("grandchild", "Grandchild", "child-10"),
		], dormant: [], selectedAgentId: "child-10",
	});
	const component = harness.component!;
	let rendered = renderPanel(component, 80);
	assert.match(rendered.join("\n"), /\[Owner\]\[›\] Branch/);
	assert.match(rendered.join("\n"), /→ Child 10.*\[1 child ›\]\s+│/);
	component.handleInput?.("j");
	rendered = renderPanel(component, 80);
	assert.match(rendered.join("\n"), /\[Owner\]\[›\] Branch/);
	assert.match(rendered.join("\n"), /→ Child 11/);
	assert.ok(rendered.length <= 13);
	component.handleInput?.("k");
	component.handleInput?.("\x1b[C");
	assert.match(renderPanel(component, 80).join("\n"), /→ Grandchild/);
	component.handleInput?.("h");
	component.handleInput?.("\r");
	assert.deepEqual(await selection, { kind: "select_agent", agentId: "child-10" });
});

test("Owner root browsing falls back to a root Agent when its ancestor is Dormant", async () => {
	const harness = surfaceHarness(24);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [
			agentStatus("owner", "Owner", null),
			agentStatus("root", "Root", "owner"),
			agentStatus("leaf", "Leaf", "sleeping"),
		], dormant: [dormantAgentStatus("sleeping", "Sleeping", "owner")],
		selectedAgentId: "leaf",
		humanAttention: [{ requestId: "request", agentId: "leaf", agentLabel: "Leaf", question: "Proceed?" }],
	});
	const component = harness.component!;
	component.handleInput?.("j");
	component.handleInput?.("l");
	assert.match(renderPanel(component, 80).join("\n"), /→ Root/);
	component.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

test("focused Owner keeps preparation feedback and input ownership until selection completes", async () => {
	const harness = surfaceHarness(24);
	let release!: () => void;
	const pending = new Promise<void>((resolve) => { release = resolve; });
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null)],
		dormant: [], selectedAgentId: "owner",
		prepareSelection: () => pending,
	});
	const component = harness.component!;
	component.handleInput?.("\r");
	try {
		assert.match(renderPanel(component, 80).join("\n"), /\[\[Owner\]\].*loading/);
		component.handleInput?.("\x1b");
		assert.equal(harness.resolved, false);
	} finally {
		release();
	}
	assert.deepEqual(await selection, { kind: "select_agent", agentId: "owner" });
});

test("short Attention view retains its focused summary and pinned Owner boundary", async () => {
	const harness = surfaceHarness(10);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [agentStatus("owner", "Owner", null), agentStatus("child", "Child", "owner")],
		dormant: [], selectedAgentId: "owner",
		humanAttention: [{ requestId: "request", agentId: "child", agentLabel: "Child", question: "Proceed?" }],
	});
	const rendered = renderPanel(harness.component!, 80);
	assert.ok(rendered.length <= 8);
	assert.match(rendered.join("\n"), /→ DECIDE/);
	assert.match(rendered.join("\n"), /\[Owner\]\[›\]/);
	harness.component!.handleInput?.("\x1b");
	assert.equal(await selection, undefined);
});

test("primary pointer controls separate browsing, opening, and informational details", async () => {
	const harness = surfaceHarness(30);
	const selection = openAgentSelectorSurface(harness.ui, {
		live: [
			agentStatus("owner", "Owner", null),
			{ ...agentStatus("branch", "Branch", "owner"), description: "Informational detail" },
			agentStatus("leaf", "Leaf", "branch"),
		], dormant: [dormantAgentStatus("sleeping", "Sleeping", "owner")],
		selectedAgentId: "owner",
	});
	const component = harness.component!;
	const click = (text: string, offset = 0) => {
		const lines = component.render(80);
		const y = lines.findIndex((line) => line.includes(text));
		assert.ok(y >= 0, text);
		const x = lines[y]!.indexOf(text) + offset;
		component.handleMouse?.({
			type: "click", button: "left", x, y, screenX: x, screenY: y,
			width: 80, height: 30, shift: false, alt: false, ctrl: false,
		});
	};
	click("Dormant");
	assert.match(component.render(80).join("\n"), /→ Sleeping/);
	click("Live");
	click("Informational detail");
	assert.equal(harness.resolved, false);
	click("[1 child ›]", 5);
	assert.match(component.render(80).join("\n"), /→ Leaf/);
	assert.equal(harness.resolved, false);
	click("[›]");
	assert.match(component.render(80).join("\n"), /→ Branch/);
	click("Branch");
	assert.deepEqual(await selection, { kind: "select_agent", agentId: "branch" });
});

function renderPanel(component: Component | undefined, width: number): string[] {
	const lines = component?.render(width) ?? [];
	const top = lines.findIndex((line) => line.includes("┌"));
	const bottom = lines.findIndex((line) => line.includes("└"));
	const left = lines[top]?.indexOf("┌") ?? 0;
	return lines.slice(top, bottom + 1).map((line) => line.slice(left).trimEnd());
}
