import { coordinationEntries } from "../transcript/retained-transcript.ts";
import { isDeepStrictEqual } from "node:util";

import type { TranscriptInspection } from "../transcript/agent-transcript.ts";
import { OBLIGATION_REMINDER_CUSTOM_TYPE } from "./custom-entry-types.ts";
import {
	ProtocolInvariantError,
} from "./identities.ts";
import type { EntryPointer } from "./moderator-input.ts";

export { OBLIGATION_REMINDER_CUSTOM_TYPE } from "./custom-entry-types.ts";

export const MAX_OBLIGATION_REMINDER_SNIPPET_CODE_POINTS = 160;
export const OBLIGATION_REMINDER_GUIDANCE =
	"You still owe an Answer to this Request. Call agent_message with operation \"answer\" now. Unless another obligation or independent task remains, end the turn immediately afterward.";

export type ObligationReminder = Readonly<{
	requestMessageId: string;
	requestSnippet: string;
	guidance: typeof OBLIGATION_REMINDER_GUIDANCE;
}>;

export type ModelVisibleObligationReminder = Readonly<{
	customType: typeof OBLIGATION_REMINDER_CUSTOM_TYPE;
	content: string;
	display: true;
}>;

export function createModelVisibleObligationReminder(options: {
	requestMessageId: string;
	question: string;
}): ModelVisibleObligationReminder {
	return {
		customType: OBLIGATION_REMINDER_CUSTOM_TYPE,
		content: JSON.stringify(reminderFor(options)),
		display: true,
	};
}

export function obligationReminderDeliveryId(requestMessageId: string): string {
	return JSON.stringify(["obligation_reminder", requestMessageId]);
}

export function inspectObligationReminder(options: {
	recipientAgentId: string;
	transcript: TranscriptInspection;
	requestMessageId: string;
	question: string;
}): EntryPointer | undefined {
	const expected = reminderFor(options);
	const matches: string[] = [];
	for (const entry of coordinationEntries(options.transcript, options.recipientAgentId, `custom:${OBLIGATION_REMINDER_CUSTOM_TYPE}`)) {
		if (
			entry.type !== "custom_message" ||
			entry.customType !== OBLIGATION_REMINDER_CUSTOM_TYPE
		) continue;
		if (!entry.display || typeof entry.content !== "string") {
			throw new ProtocolInvariantError(
				"Obligation Reminder must be model-visible JSON text",
			);
		}
		const committed = parseObligationReminder(entry.content);
		if (committed.requestMessageId !== options.requestMessageId) continue;
		if (!isDeepStrictEqual(committed, expected)) {
			throw new ProtocolInvariantError(
				"Obligation Reminder contradicts its runtime-authored Delivery",
			);
		}
		matches.push(entry.id);
	}
	if (matches.length > 1) {
		throw new ProtocolInvariantError("Obligation Reminder has duplicate Deliveries");
	}
	return matches[0]
		? { agentId: options.recipientAgentId, entryId: matches[0] }
		: undefined;
}

function reminderFor(options: {
	requestMessageId: string;
	question: string;
}): ObligationReminder {
	return {
		requestMessageId: options.requestMessageId,
		requestSnippet: boundedRequestSnippet(options.question),
		guidance: OBLIGATION_REMINDER_GUIDANCE,
	};
}

function boundedRequestSnippet(question: string): string {
	const normalized = question.replaceAll(/\s+/g, " ").trim();
	const codePoints = [...normalized];
	return codePoints.length <= MAX_OBLIGATION_REMINDER_SNIPPET_CODE_POINTS
		? normalized
		: `${codePoints.slice(0, MAX_OBLIGATION_REMINDER_SNIPPET_CODE_POINTS - 1).join("")}…`;
}

function parseObligationReminder(content: string): ObligationReminder {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		throw new ProtocolInvariantError(
			"Obligation Reminder content is not valid JSON",
		);
	}
	if (
		!isRecord(parsed) ||
		!hasExactKeys(parsed, ["requestMessageId", "requestSnippet", "guidance"]) ||
		!isProtocolString(parsed.requestMessageId) ||
		typeof parsed.requestSnippet !== "string" ||
		parsed.requestSnippet.includes("\0") ||
		parsed.guidance !== OBLIGATION_REMINDER_GUIDANCE
	) {
		throw new ProtocolInvariantError("Obligation Reminder has an invalid shape");
	}
	return {
		requestMessageId: parsed.requestMessageId,
		requestSnippet: parsed.requestSnippet,
		guidance: OBLIGATION_REMINDER_GUIDANCE,
	};
}

function hasExactKeys(
	record: Record<string, unknown>,
	expectedKeys: readonly string[],
): boolean {
	const actual = Object.keys(record).sort();
	const expected = [...expectedKeys].sort();
	return actual.length === expected.length &&
		actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProtocolString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.includes("\0");
}
