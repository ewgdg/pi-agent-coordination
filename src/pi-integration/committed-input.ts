import type { SessionManager } from "@earendil-works/pi-coding-agent";

type PersistableSessionManager = {
	_rewriteFile(): void;
	flushed: boolean;
};

export function persistCommittedInput(sessionManager: SessionManager): void {
	if (!sessionManager.isPersisted()) return;
	// Pi normally defers a new transcript's first write until an assistant Message.
	// Moderator identity must survive a startup failure before that Message exists.
	const persistable = sessionManager as unknown as PersistableSessionManager;
	if (
		typeof persistable._rewriteFile !== "function" ||
		typeof persistable.flushed !== "boolean"
	) {
		throw new Error("Incompatible Pi host: Moderator Input persistence is unavailable");
	}
	persistable._rewriteFile();
	// Keep Pi's append path aligned with the file we just materialized; otherwise
	// its first assistant append attempts exclusive creation of the existing file.
	persistable.flushed = true;
}
