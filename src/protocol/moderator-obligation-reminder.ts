import { coordinationEntries } from "../transcript/retained-transcript.ts";
import type { TranscriptInspection } from "../transcript/agent-transcript.ts";
import { MODERATOR_OBLIGATION_REMINDER_CUSTOM_TYPE } from "./custom-entry-types.ts";
import { ProtocolInvariantError } from "./identities.ts";
import type { EntryPointer } from "./moderator-input.ts";

export const MODERATOR_OBLIGATION_REMINDER_GUIDANCE =
	"You still own unresolved incident handling. Inspect the original Moderator Input and the current evidence for its affected Agents and Requests. Continue handling; call moderator_control with operation \"resolve\" only when the original condition clears and your incoming and outgoing Request responsibilities are settled.";

export type ModelVisibleModeratorObligationReminder = Readonly<{
	customType: typeof MODERATOR_OBLIGATION_REMINDER_CUSTOM_TYPE;
	content: string;
	display: true;
}>;

export function createModelVisibleModeratorObligationReminder(): ModelVisibleModeratorObligationReminder {
	return {
		customType: MODERATOR_OBLIGATION_REMINDER_CUSTOM_TYPE,
		content: MODERATOR_OBLIGATION_REMINDER_GUIDANCE,
		display: true,
	};
}

export function moderatorObligationReminderDeliveryId(moderatorAgentId: string): string {
	// Each Moderator Input creates a fresh Agent with one handling responsibility.
	return JSON.stringify(["moderator_obligation_reminder", moderatorAgentId]);
}

export function inspectModeratorObligationReminder(options: {
	moderatorAgentId: string;
	transcript: TranscriptInspection;
}): EntryPointer | undefined {
	const entries = coordinationEntries(options.transcript, options.moderatorAgentId,
		`custom:${MODERATOR_OBLIGATION_REMINDER_CUSTOM_TYPE}`).filter((entry) =>
		entry.type === "custom_message" && entry.customType === MODERATOR_OBLIGATION_REMINDER_CUSTOM_TYPE);
	if (entries.length > 1) {
		throw new ProtocolInvariantError("Moderator Obligation Reminder has duplicate Deliveries");
	}
	const entry = entries[0];
	if (!entry) return undefined;
	if (entry.type !== "custom_message" || !entry.display ||
		entry.content !== MODERATOR_OBLIGATION_REMINDER_GUIDANCE) {
		throw new ProtocolInvariantError("Moderator Obligation Reminder contradicts its runtime-authored Delivery");
	}
	return { agentId: options.moderatorAgentId, entryId: entry.id };
}
