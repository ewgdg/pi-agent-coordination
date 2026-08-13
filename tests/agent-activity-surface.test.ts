import assert from "node:assert/strict";
import test from "node:test";

import type {
	ExtensionAPI,
	ExtensionUIContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";

import { createAgentActivityExtension } from "../src/bootstrap/agent-extension.ts";
import type {
	AgentRosterStatus,
	HumanPresentationCoordinatorView,
} from "../src/coordination/workflow-coordinator.ts";
import {
	AgentActivityDock,
	AGENT_ACTIVITY_WIDGET_KEY,
	installAgentActivityDock,
	type AgentActivitySnapshot,
	type AgentActivitySource,
} from "../src/presentation/agent-activity-surface.ts";

const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bold: (text: string) => `<bold>${text}</bold>`,
} as Theme;

function agent(options: {
	agentId: string;
	label: string;
	parent: string | null;
	run?: AgentRosterStatus["run"];
	model?: string;
	thinking?: AgentRosterStatus["thinking"];
	queued?: number;
	failed?: boolean;
}): AgentActivitySnapshot["scope"] {
	return {
		agentId: options.agentId,
		workflowId: "owner",
		label: options.label,
		directSpawnerAgentId: options.parent,
		primaryEvidence: {
			transcriptPath: null,
			inspectedThrough: { agentId: options.agentId, entryId: `${options.agentId}-tail` },
		},
		run: options.run ?? {
			phase: "live",
			work: "settled",
			attention: "none",
			retentionReasons: [],
		},
		model: { provider: "anthropic", modelId: options.model ?? "claude-sonnet-4" },
		thinking: options.thinking ?? "high",
		queuedInputCount: options.queued ?? 0,
		failed: options.failed ?? false,
	};
}

function source(initial: AgentActivitySnapshot) {
	let snapshot = initial;
	const handlers = new Set<() => void>();
	const source: AgentActivitySource = {
		snapshot: () => snapshot,
		addChangeHandler(handler) {
			handlers.add(handler);
			return () => handlers.delete(handler);
		},
	};
	return {
		source,
		publish(next: AgentActivitySnapshot) {
			snapshot = next;
			for (const handler of handlers) handler();
		},
		handlerCount: () => handlers.size,
	};
}

function createDock(snapshot: AgentActivitySnapshot) {
	let renders = 0;
	const snapshots = source(snapshot);
	const dock = new AgentActivityDock(
		{ requestRender: () => renders += 1 } as unknown as TUI,
		theme,
		snapshots.source,
	);
	return {
		dock,
		snapshots,
		renderRequests: () => renders,
	};
}

test("activity extension publishes native model-selection changes", async () => {
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const pi = {
		on(event: string, handler: (...args: unknown[]) => unknown) {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
	} as unknown as ExtensionAPI;
	let refreshes = 0;
	const view = {
		refreshAgentActivity() {
			refreshes += 1;
		},
	} as unknown as HumanPresentationCoordinatorView;

	await createAgentActivityExtension(() => view)(pi);
	const modelSelect = handlers.get("model_select")?.[0];
	assert.ok(modelSelect);
	await modelSelect();
	assert.equal(refreshes, 1);
});

test("activity installs as one persistent native above-editor widget", () => {
	const snapshots = source({
		scope: agent({ agentId: "leaf-12345678", label: "Leaf", parent: "owner" }),
		children: [],
		answerMode: false,
		humanAttention: [],
		operationalAttention: [],
	});
	let installedKey: string | undefined;
	let installedFactory: ((tui: TUI, theme: Theme) => AgentActivityDock) | undefined;
	let installedOptions: unknown;
	const ui = {
		setWidget(key: string, factory: typeof installedFactory, options: unknown) {
			installedKey = key;
			installedFactory = factory;
			installedOptions = options;
		},
	} as unknown as ExtensionUIContext;

	installAgentActivityDock(ui, snapshots.source);
	assert.equal(installedKey, AGENT_ACTIVITY_WIDGET_KEY);
	assert.deepEqual(installedOptions, { placement: "aboveEditor" });
	assert.ok(installedFactory);
	const dock = installedFactory(
		{ requestRender() {} } as unknown as TUI,
		theme,
	);
	assert.match(dock.render(80).join("\n"), /Leaf.*12345678.*idle/);
	dock.dispose();
});

test("Owner activity renders Attention Inbox above direct children in creation order", () => {
	const owner = agent({ agentId: "owner", label: "Owner", parent: null });
	const first = agent({
		agentId: "researcher",
		label: "Researcher",
		parent: "owner",
		run: {
			phase: "live",
			work: "active",
			attention: "input_required",
			retentionReasons: [],
		},
	});
	const second = agent({
		agentId: "builder",
		label: "Builder",
		parent: "owner",
		queued: 2,
	});
	const { dock } = createDock({
		scope: owner,
		children: [first, second],
		answerMode: false,
		humanAttention: [{
			requestId: "request-1",
			agentId: "researcher",
			agentLabel: "Researcher",
			question: "Which boundary should remain authoritative for the final implementation?",
		}],
		operationalAttention: [{
			trigger: {
				kind: "dependency_deadlock",
				agentIds: ["researcher", "builder"],
				requests: { total: 1, sources: [] },
			},
			affectedAgentIds: ["researcher", "builder"],
			diagnostics: [],
		}],
	});

	const rendered = dock.render(200);
	assert.match(rendered[0]!, /Attention Inbox/);
	assert.match(rendered[1]!, /DECIDE.*Researcher.*Which boundary should remain authoritative/);
	assert.match(rendered[2]!, /ATTENTION.*Dependency Deadlock/);
	assert.match(rendered[3]!, /Agents/);
	assert.match(rendered[4]!, /Researcher/);
	assert.match(rendered[5]!, /Builder.*2 queued/);
	dock.dispose();
});

test("Attention Inbox shows three items and reports the hidden remainder", () => {
	const { dock } = createDock({
		scope: agent({ agentId: "owner", label: "Owner", parent: null }),
		children: [],
		answerMode: false,
		humanAttention: Array.from({ length: 5 }, (_, index) => ({
			requestId: `request-${index + 1}`,
			agentId: `agent-${index + 1}`,
			agentLabel: `Agent ${index + 1}`,
			question: `Question ${index + 1}?`,
		})),
		operationalAttention: [],
	});

	const rendered = dock.render(120).map((line) =>
		stripTerminalSequences(line).replace(/<[^>]+>/g, "")
	);
	assert.deepEqual(rendered, [
		"Attention Inbox",
		"├─ DECIDE Agent 1 · Question 1?",
		"├─ DECIDE Agent 2 · Question 2?",
		"├─ DECIDE Agent 3 · Question 3?",
		"└─ … 2 more",
	]);
	dock.dispose();
});

test("activity roster shows three live children and reports the hidden remainder", () => {
	const { dock } = createDock({
		scope: agent({ agentId: "owner", label: "Owner", parent: null }),
		children: Array.from({ length: 6 }, (_, index) => agent({
			agentId: `child-${index + 1}`,
			label: `Child ${index + 1}`,
			parent: "owner",
		})),
		answerMode: false,
		humanAttention: [],
		operationalAttention: [],
	});

	const rendered = dock.render(120).map((line) =>
		stripTerminalSequences(line).replace(/<[^>]+>/g, "")
	);
	assert.deepEqual(rendered, [
		"Agents",
		"├─ ○ Child 1 · anthropic/claude-sonnet-4:high · idle",
		"├─ ○ Child 2 · anthropic/claude-sonnet-4:high · idle",
		"├─ ○ Child 3 · anthropic/claude-sonnet-4:high · idle",
		"└─ … 3 more",
	]);
	dock.dispose();
});

test("Owner activity renders direct children without requiring attention", () => {
	const { dock } = createDock({
		scope: agent({ agentId: "owner", label: "Owner", parent: null }),
		children: [agent({ agentId: "child", label: "Child", parent: "owner" })],
		answerMode: false,
		humanAttention: [],
		operationalAttention: [],
	});

	const rendered = dock.render(120).join("\n");
	assert.match(rendered, /^<toolTitle><bold>Agents/);
	assert.match(rendered, /Child/);
	assert.doesNotMatch(rendered, /Attention Inbox/);
	dock.dispose();
});

test("nested Agent activity shows identity and only its direct children", () => {
	const { dock } = createDock({
		scope: agent({
			agentId: "agent-researcher-12345678",
			label: "Researcher",
			parent: "owner",
			run: {
				phase: "live",
				work: "active",
				attention: "none",
				retentionReasons: [],
			},
		}),
		children: [
			agent({ agentId: "source-scout", label: "Source Scout", parent: "agent-researcher-12345678" }),
			agent({ agentId: "synthesizer", label: "Synthesizer", parent: "agent-researcher-12345678" }),
		],
		answerMode: false,
		humanAttention: [{
			requestId: "owner-only",
			agentId: "sibling",
			agentLabel: "Sibling",
			question: "Owner-only decision",
		}],
		operationalAttention: [],
	});

	const rendered = dock.render(160).join("\n");
	assert.match(
		rendered,
		/^<accent><bold>Researcher<\/bold><\/accent><dim> · 12345678 · <\/dim><success>active<\/success>/,
	);
	assert.match(rendered, /Source Scout/);
	assert.match(rendered, /Synthesizer/);
	assert.doesNotMatch(rendered, /Sibling|Attention Inbox|DECIDE/);
	dock.dispose();
});

test("leaf selection keeps only the plain identity directly above the editor", () => {
	const { dock } = createDock({
		scope: agent({
			agentId: "leaf-agent-87654321",
			label: "Leaf",
			parent: "owner",
		}),
		children: [],
		answerMode: false,
		humanAttention: [],
		operationalAttention: [],
	});

	assert.deepEqual(dock.render(120), [
		"<accent><bold>Leaf</bold></accent><dim> · 87654321 · </dim><dim>idle</dim>",
	]);
	dock.dispose();
});

test("selected Agent activity projects Answer mode directly above its native editor", () => {
	const { dock } = createDock({
		scope: agent({
			agentId: "requester-12345678",
			label: "Requester",
			parent: "owner",
			run: {
				phase: "live",
				work: "active",
				attention: "input_required",
				retentionReasons: [],
			},
		}),
		children: [],
		answerMode: true,
		humanAttention: [],
		operationalAttention: [],
	});

	const rendered = dock.render(120);
	assert.match(rendered[0]!, /Requester.*waiting \(human input\)/);
	assert.equal(
		stripTerminalSequences(rendered.at(-1)!).replace(/<[^>]+>/g, ""),
		"ANSWER · Enter submits",
	);
	dock.dispose();
});

test("activity lists only Agents with a current Run", () => {
	const { dock } = createDock({
		scope: agent({ agentId: "owner", label: "Owner", parent: null }),
		children: [
			agent({
				agentId: "starting-child",
				label: "Starting Child",
				parent: "owner",
				run: { phase: "starting", attention: "none", retentionReasons: [] },
			}),
			agent({ agentId: "live-child", label: "Live Child", parent: "owner" }),
			agent({
				agentId: "ending-child",
				label: "Ending Child",
				parent: "owner",
				run: { phase: "ending", attention: "none", retentionReasons: [] },
			}),
			agent({
				agentId: "dormant-child",
				label: "Dormant Child",
				parent: "owner",
				run: { phase: "dormant", retentionReasons: [] },
			}),
		],
		answerMode: false,
		humanAttention: [],
		operationalAttention: [],
	});

	const rendered = stripTerminalSequences(dock.render(160).join("\n"));
	assert.match(rendered, /Starting Child/);
	assert.match(rendered, /Live Child/);
	assert.match(rendered, /Ending Child/);
	assert.doesNotMatch(rendered, /Dormant Child|Dormant/);
	dock.dispose();
});

test("activity updates volatile state and rebinds scope without retaining a stale subscription", () => {
	const initial: AgentActivitySnapshot = {
		scope: agent({ agentId: "owner", label: "Owner", parent: null }),
		children: [agent({ agentId: "live-child", label: "Live Child", parent: "owner" })],
		answerMode: false,
		humanAttention: [],
		operationalAttention: [],
	};
	const { dock, snapshots, renderRequests } = createDock(initial);
	assert.match(stripTerminalSequences(dock.render(100).join("\n")), /Live Child.*idle/);

	snapshots.publish({
		scope: agent({ agentId: "nested-12345678", label: "Nested", parent: "owner" }),
		children: [],
		answerMode: false,
		humanAttention: [],
		operationalAttention: [],
	});
	assert.equal(renderRequests(), 1);
	assert.match(
		stripTerminalSequences(dock.render(100).join("\n")).replace(/<[^>]+>/g, ""),
		/Nested · 12345678 · idle/,
	);
	assert.equal(snapshots.handlerCount(), 1);
	dock.dispose();
	assert.equal(snapshots.handlerCount(), 0);
});
