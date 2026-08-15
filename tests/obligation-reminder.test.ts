import assert from "node:assert/strict";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { transcriptFromSessionManager } from "../src/pi-integration/session-manager-transcript.ts";
import { AGENT_IDENTITY_CUSTOM_TYPE } from "../src/protocol/owner-identity.ts";
import {
	createModelVisibleObligationReminder,
	inspectObligationReminder,
	MAX_OBLIGATION_REMINDER_SNIPPET_CODE_POINTS,
	OBLIGATION_REMINDER_GUIDANCE,
	obligationReminderDeliveryId,
} from "../src/protocol/obligation-reminder.ts";

test("Obligation Reminder contains one bounded Request snippet and durable correlation", () => {
	const question = `  Finish   the required Answer after reviewing ${"evidence ".repeat(40)}  `;
	const reminder = createModelVisibleObligationReminder({
		requestMessageId: "request-1",
		question,
	});
	const content = JSON.parse(reminder.content) as {
		requestMessageId: string;
		requestSnippet: string;
		guidance: string;
	};

	assert.equal(reminder.customType, "agent-coordination.obligation-reminder");
	assert.equal(reminder.display, true);
	assert.deepEqual(Object.keys(content).sort(), [
		"guidance",
		"requestMessageId",
		"requestSnippet",
	]);
	assert.equal(content.requestMessageId, "request-1");
	assert.equal(content.guidance, OBLIGATION_REMINDER_GUIDANCE);
	assert.equal(content.requestSnippet.includes("  "), false);
	assert.equal([...content.requestSnippet].length, MAX_OBLIGATION_REMINDER_SNIPPET_CODE_POINTS);
	assert.equal(content.requestSnippet.endsWith("…"), true);
	assert.equal(content.requestSnippet.includes("evidence evidence"), true);
	assert.equal(reminder.content.includes(question.trim()), false);
	assert.equal(
		obligationReminderDeliveryId("request-1"),
		JSON.stringify(["obligation_reminder", "request-1"]),
	);
});

test("Obligation Reminder inspection proves one exact runtime-authored Delivery", () => {
	const sessionManager = SessionManager.inMemory(process.cwd());
	const recipientAgentId = sessionManager.getSessionId();
	sessionManager.appendCustomEntry(AGENT_IDENTITY_CUSTOM_TYPE, {
		agentId: recipientAgentId,
	});
	const reminder = createModelVisibleObligationReminder({
		requestMessageId: "request-2",
		question: "Provide the exact Answer now.",
	});
	sessionManager.appendCustomMessageEntry(
		reminder.customType,
		reminder.content,
		reminder.display,
	);
	const delivery = sessionManager.getLeafEntry();
	assert.ok(delivery);

	assert.deepEqual(inspectObligationReminder({
		recipientAgentId,
		transcript: transcriptFromSessionManager(sessionManager).inspect(),
		requestMessageId: "request-2",
		question: "Provide the exact Answer now.",
	}), {
		agentId: recipientAgentId,
		entryId: delivery.id,
	});

	sessionManager.appendCustomMessageEntry(
		reminder.customType,
		reminder.content,
		reminder.display,
	);
	assert.throws(
		() => inspectObligationReminder({
			recipientAgentId,
			transcript: transcriptFromSessionManager(sessionManager).inspect(),
			requestMessageId: "request-2",
			question: "Provide the exact Answer now.",
		}),
		/duplicate Deliveries/,
	);
});
