import { appendFileSync } from "node:fs";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

// Hold an actual native model call, not the parent's cached work-state projection.
const fixture: ExtensionFactory = (pi) => {
	let firstContext = true;
	let release: (() => void) | undefined;
	pi.on("context", async (event, ctx) => {
		const path = process.env.MODERATOR_REMINDER_CONTEXT_PATH;
		if (!path) throw new Error("Missing moderator reminder context evidence path");
		appendFileSync(path, JSON.stringify(event.messages) + "\n");
		if (!firstContext) return;
		firstContext = false;
		const released = new Promise<void>((resolve) => { release = resolve; });
		ctx.ui.setWidget("reminder-gate", ["REMINDER_CONTEXT_HELD"]);
		await released;
	});
	pi.registerCommand("release-reminder-context", {
		description: "Release the deterministic test model-context gate",
		async handler(_args, ctx) {
			if (!release) throw new Error("Reminder context gate is not held");
			release();
			release = undefined;
			ctx.ui.setWidget("reminder-gate", ["REMINDER_CONTEXT_RELEASED"]);
		},
	});
};
export default fixture;
