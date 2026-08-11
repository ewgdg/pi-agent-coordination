import { appendFile } from "node:fs/promises";

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

const EVIDENCE_PATH_VARIABLE = "PROCESS_DETACHED_UI_PROBE_PATH";

const detachedChildUiProbe: ExtensionFactory = (pi) => {
	pi.on("session_start", async (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const evidencePath = process.env[EVIDENCE_PATH_VARIABLE];
		if (!evidencePath) {
			throw new Error(`${EVIDENCE_PATH_VARIABLE} is required`);
		}
		await appendFile(
			evidencePath,
			`${JSON.stringify({ sessionId, pid: process.pid })}\n`,
			{ encoding: "utf8", mode: 0o600 },
		);
		ctx.ui.notify(`__PTY_DETACHED_BANNER_${sessionId}__`, "error");
	});
};

export default detachedChildUiProbe;
