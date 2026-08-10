import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import { HumanRequestSurface } from "../src/presentation/human-request-surface.ts";

test("Human Request storage delegates passive rendering to the scoped activity dock", () => {
	let terminalListenerRemoved = 0;
	const ui = {
		onTerminalInput() {
			return () => terminalListenerRemoved += 1;
		},
		setStatus() {
			throw new Error("HumanRequestSurface must not render a duplicate status");
		},
		setWidget() {
			throw new Error("HumanRequestSurface must not render a duplicate widget");
		},
	} as unknown as ExtensionUIContext;
	const surface = new HumanRequestSurface(ui);
	const presentation = {
		requestId: "human-request",
		agentId: "child-agent",
		agentLabel: "Child",
		questionCount: 1,
		request: {
			requestId: "human-request",
			requesterAgentId: "child-agent",
			source: {
				agentId: "child-agent",
				entryId: "request-entry",
				toolCallId: "request-call",
			},
			questions: [{
				kind: "text" as const,
				header: "Decision",
				prompt: "Choose.",
				multiline: false,
			}],
		},
		submit: () => true,
		ownsInteractiveSelection: () => false,
		interrupt() {},
	};

	surface.present(presentation, false);
	assert.deepEqual(surface.items(), [{
		requestId: "human-request",
		agentId: "child-agent",
		agentLabel: "Child",
		questionCount: 1,
	}]);
	surface.dismiss("human-request");
	assert.deepEqual(surface.items(), []);
	assert.equal(terminalListenerRemoved, 1);
});
