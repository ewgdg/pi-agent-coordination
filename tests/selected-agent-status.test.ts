import assert from "node:assert/strict";
import test from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";

import {
	SelectedAgentStatusSurface,
	formatSelectedAgentStatus,
} from "../src/presentation/selected-agent-status.ts";

const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bold: (text: string) => `<bold>${text}</bold>`,
} as Theme;

test("selected Agent footer emphasizes identity and keeps ordinary Run states dim", () => {
	assert.equal(
		formatSelectedAgentStatus(
			{ label: "Researcher", sessionId: "019fa1ff-6e95-761e-b4ce-7415983c81e3", phase: "active" },
			theme,
		),
		"<accent><bold>● Researcher</bold></accent><dim> · 983c81e3 · active</dim>",
	);
	assert.equal(
		formatSelectedAgentStatus(
			{ label: "Researcher", sessionId: "019fa1ff-6e95-761e-b4ce-7415983c81e3", phase: "settled" },
			theme,
		),
		"<accent><bold>Researcher</bold></accent><dim> · 983c81e3 · settled</dim>",
	);
	assert.equal(
		formatSelectedAgentStatus(
			{ label: "Researcher", sessionId: "019fa1ff-6e95-761e-b4ce-7415983c81e3", phase: "held" },
			theme,
		),
		"<accent><bold>Researcher</bold></accent><dim> · 983c81e3 · held</dim>",
	);
});

test("Dormant selection emphasizes identity and is distinct from a failed Run", () => {
	assert.equal(
		formatSelectedAgentStatus(
			{ label: "Researcher", sessionId: "019fa1ff-6e95-761e-b4ce-7415983c81e3", phase: "dormant" },
			theme,
		),
		"<accent><bold>Researcher</bold></accent><dim> · 983c81e3 · Dormant</dim>",
	);
	assert.equal(
		formatSelectedAgentStatus(
			{ label: "Researcher", sessionId: "019fa1ff-6e95-761e-b4ce-7415983c81e3", phase: "failed" },
			theme,
		),
		"<error>Researcher · 983c81e3 · failed</error>",
	);
});

test("only Human-waiting receives warning emphasis", () => {
	assert.equal(
		formatSelectedAgentStatus(
			{
				label: "Researcher",
				sessionId: "019fa1ff-6e95-761e-b4ce-7415983c81e3",
				phase: "waiting_human",
			},
			theme,
		),
		"<accent><bold>Researcher</bold></accent><dim> · 983c81e3 · </dim><warning>waiting (human)</warning>",
	);
});

test("status surface updates one native footer slot and clears it", () => {
	const updates: Array<{ key: string; value: string | undefined }> = [];
	const surface = new SelectedAgentStatusSurface({
		theme,
		setStatus(key, value) {
			updates.push({ key, value });
		},
	});

	surface.present(
		{ label: "Researcher", sessionId: "agent-researcher", phase: "settled" },
	);
	surface.clear();

	assert.equal(updates.length, 2);
	assert.equal(updates[0]?.key, updates[1]?.key);
	assert.equal(
		updates[0]?.value,
		"<accent><bold>Researcher</bold></accent><dim> · searcher · settled</dim>",
	);
	assert.equal(updates[1]?.value, undefined);
});
