import { access, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export const MODERATOR_STARTUP_GATE_DIRECTORY = "PI_TEST_MODERATOR_STARTUP_GATE_DIRECTORY";
export const STARTED_FILE = "started.json";
export const RELEASE_FILE = "release";

const fixture: ExtensionFactory = pi => {
	let firstStart = true;
	pi.on("agent_start", async (_event, ctx) => {
		const directory = process.env[MODERATOR_STARTUP_GATE_DIRECTORY];
		if (!directory || !firstStart || !ctx.sessionManager.getEntries().some(entry =>
			entry.type === "custom_message" && entry.customType === "agent-coordination.moderator-input")) return;
		firstStart = false;
		await writeFile(join(directory, STARTED_FILE + ".writing"), JSON.stringify({ agentId: ctx.sessionManager.getSessionId(), idle: ctx.isIdle() }));
		await rename(join(directory, STARTED_FILE + ".writing"), join(directory, STARTED_FILE));
		for (;;) {
			try { await access(join(directory, RELEASE_FILE)); return; }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			await setTimeout(1);
		}
	});
};
export default fixture;
