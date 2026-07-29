import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

import { AgentActivity } from "./agent-activity.ts";
import type { InProcessSupervisorCoordinator } from "./supervisor-coordinator.ts";

function theme(): Theme {
	return {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		bold: (text: string) => `<bold>${text}</bold>`,
	} as Theme;
}

test("Owner activity prepends DECIDE attention and marks the requesting direct child", () => {
	const researcher = {
		session: {
			model: { id: "gpt-5.6-sol" },
			thinkingLevel: "high",
			isStreaming: false,
			pendingMessageCount: 0,
		},
	};
	const builder = {
		session: {
			model: { id: "gpt-5.6-sol" },
			thinkingLevel: "high",
			isStreaming: false,
			pendingMessageCount: 0,
		},
	};
	const events = new EventEmitter();
	const coordinator = Object.assign(events, {
		childrenOf: () => [
			{ definition: { key: "researcher", name: "Researcher" }, slot: researcher },
			{ definition: { key: "builder", name: "Builder" }, slot: builder },
		],
		pendingHumanRequests: () => [
			{ agentKey: "researcher", prompt: "Which implementation should I use?" },
		],
		phaseOf: (key: string) => (key === "researcher" ? "waiting_human" : "idle"),
	}) as unknown as InProcessSupervisorCoordinator;
	const tui = { requestRender() {} } as unknown as TUI;
	const activity = new AgentActivity(tui, theme(), coordinator, "owner");

	assert.deepEqual(activity.render(200), [
		"<toolTitle><bold>Attention Inbox</bold></toolTitle>",
		"└─ <warning>DECIDE</warning> <bold>Researcher</bold> · Which implementation should I use?",
		"<toolTitle><bold>Agents</bold></toolTitle>",
		"├─ <warning>■</warning> <bold>Researcher</bold> · gpt-5.6-sol:high · <warning>waiting (human)</warning>",
		"└─ ○ <bold>Builder</bold> · gpt-5.6-sol:high · idle",
	]);
	activity.dispose();
});

test("child activity never shows Owner attention or sibling Agents", () => {
	const events = new EventEmitter();
	const coordinator = Object.assign(events, {
		childrenOf: () => [],
		pendingHumanRequests: () => [
			{ agentKey: "builder", prompt: "Approve this?" },
		],
	}) as unknown as InProcessSupervisorCoordinator;
	const tui = { requestRender() {} } as unknown as TUI;
	const activity = new AgentActivity(tui, theme(), coordinator, "researcher");

	assert.deepEqual(activity.render(200), []);
	activity.dispose();
});

test("selected child activity shows only that Agent's direct children", () => {
	const sourceScout = {
		session: {
			model: { id: "gpt-5.6-sol" },
			thinkingLevel: "high",
			isStreaming: true,
			pendingMessageCount: 0,
		},
	};
	const synthesizer = {
		session: {
			model: { id: "gpt-5.6-sol" },
			thinkingLevel: "high",
			isStreaming: false,
			pendingMessageCount: 0,
		},
	};
	const events = new EventEmitter();
	const coordinator = Object.assign(events, {
		childrenOf: () => [
			{ definition: { key: "source-scout", name: "Source Scout" }, slot: sourceScout },
			{ definition: { key: "synthesizer", name: "Synthesizer" }, slot: synthesizer },
		],
		pendingHumanRequests: () => [
			{ agentKey: "reviewer", prompt: "Approve this?" },
		],
		phaseOf: (key: string) => (key === "source-scout" ? "working" : "idle"),
	}) as unknown as InProcessSupervisorCoordinator;
	const tui = { requestRender() {} } as unknown as TUI;
	const activity = new AgentActivity(tui, theme(), coordinator, "researcher");

	const rendered = activity.render(200).join("\n");
	assert.match(rendered, /Source Scout/);
	assert.match(rendered, /Synthesizer/);
	assert.doesNotMatch(rendered, /Reviewer|Attention Inbox|DECIDE/);
	activity.dispose();
});
