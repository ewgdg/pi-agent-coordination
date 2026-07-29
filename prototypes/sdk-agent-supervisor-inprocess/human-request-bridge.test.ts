import assert from "node:assert/strict";
import test from "node:test";

import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { HumanRequestBridge } from "./human-request-bridge.ts";

type ObservedSession = AgentSession & {
	events: Array<{ type: string; message: { role: string; content: unknown } }>;
	persisted: Array<{ role: string; content: unknown }>;
};

function fakeSession(): ObservedSession {
	const messages: Array<{ role: string; content: unknown }> = [];
	const events: ObservedSession["events"] = [];
	const persisted: ObservedSession["persisted"] = [];
	return {
		events,
		persisted,
		model: { api: "openai-responses", provider: "codex-lb", id: "gpt-5.6-sol" },
		get messages() {
			return messages;
		},
		sessionManager: {
			appendMessage(message: { role: string; content: unknown }) {
				persisted.push(message);
			},
		},
		_emit(event: ObservedSession["events"][number]) {
			events.push(event);
		},
	} as unknown as ObservedSession;
}

test("child Human Request becomes Owner attention and the answer settles in its native transcript", async () => {
	const session = fakeSession();
	const bridge = new HumanRequestBridge(() => session);
	const answerPromise = bridge.request("researcher", "Which implementation should I use?");

	assert.deepEqual(bridge.pendingFor("researcher"), {
		agentKey: "researcher",
		prompt: "Which implementation should I use?",
	});
	assert.deepEqual(
		session.persisted.map(({ role, content }) => ({ role, content })),
		[
			{
				role: "assistant",
				content: [{ type: "text", text: "Which implementation should I use?" }],
			},
		],
	);

	assert.equal(bridge.answer("researcher", "Use Pi's native transcript."), true);
	assert.equal(await answerPromise, "Use Pi's native transcript.");
	assert.equal(bridge.pendingFor("researcher"), undefined);
	assert.deepEqual(
		session.persisted.map(({ role, content }) => ({ role, content })),
		[
			{
				role: "assistant",
				content: [{ type: "text", text: "Which implementation should I use?" }],
			},
			{
				role: "user",
				content: [{ type: "text", text: "Use Pi's native transcript." }],
			},
		],
	);
	assert.deepEqual(
		session.events.map(({ type, message }) => `${type}:${message.role}`),
		[
			"message_start:assistant",
			"message_end:assistant",
			"message_start:user",
			"message_end:user",
		],
	);
});

test("an answer is consumed only while that child has a pending request", () => {
	const bridge = new HumanRequestBridge(() => fakeSession());

	assert.equal(bridge.answer("researcher", "late answer"), false);
});
