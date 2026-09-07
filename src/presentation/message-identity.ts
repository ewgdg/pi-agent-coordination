const COMPACT_MESSAGE_IDENTITY_LENGTH = 8;

/** Compact display is a selector hint; callers can expand if its suffix is ambiguous. */
export function formatMessageIdentity(messageId: string, expanded = false): string {
	return expanded ? messageId : messageId.slice(-COMPACT_MESSAGE_IDENTITY_LENGTH);
}
