import type {
	SessionEntry,
	SessionHeader,
} from "@earendil-works/pi-coding-agent";

export function piSessionRecency(
	header: SessionHeader,
	entries: readonly SessionEntry[],
	fileModifiedMs = 0,
): number {
	let lastActivity: number | undefined;
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "user" && message.role !== "assistant") continue;
		const activity = typeof message.timestamp === "number"
			? message.timestamp
			: Date.parse(entry.timestamp);
		if (!Number.isNaN(activity)) lastActivity = Math.max(lastActivity ?? 0, activity);
	}
	if (lastActivity !== undefined && lastActivity > 0) return lastActivity;
	const headerTime = Date.parse(header.timestamp);
	return Number.isNaN(headerTime) ? fileModifiedMs : headerTime;
}
