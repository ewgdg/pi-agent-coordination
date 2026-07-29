import assert from "node:assert/strict";
import test from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";

import { formatSelectedAgentStatus } from "./selected-agent-status.ts";

const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
} as Theme;

test("selected child footer keeps identity and normal phase visually quiet", () => {
	assert.equal(
		formatSelectedAgentStatus(
			{ name: "Researcher", sessionId: "019fa1ff-6e95-761e-b4ce-7415983c81e3", phase: "idle" },
			theme,
		),
		"<dim>Researcher · 983c81e3 · idle</dim>",
	);
});

test("selected child footer calls out a pending Human Answer without instructions", () => {
	assert.equal(
		formatSelectedAgentStatus(
			{
				name: "Researcher",
				sessionId: "019fa1ff-6e95-761e-b4ce-7415983c81e3",
				phase: "waiting_human",
			},
			theme,
		),
		"<dim>Researcher · 983c81e3 · </dim><warning>waiting (human)</warning>",
	);
});
