import { appendFileSync } from "node:fs";

import { CustomEditor, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const processUiProbe: ExtensionFactory = (pi) => {
	pi.registerCommand("child-view", {
		description: "Third-party process-local child view probe",
		handler: async (_args, ctx) => {
			record({
				kind: "command",
				sessionId: ctx.sessionManager.getSessionId(),
				pid: process.pid,
			});
		},
	});
	pi.on("session_start", (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		ctx.ui.notify("startup-notice", "info");
		ctx.ui.setStatus("probe-status", `status:${sessionId}`);
		ctx.ui.setWidget("probe-widget", [`probe-widget:${sessionId}:pid=${process.pid}`]);
		ctx.ui.setFooter(() => new Text(`probe-footer:${sessionId}:pid=${process.pid}`, 0, 0));
		ctx.ui.setEditorComponent((tui, theme, keybindings) =>
			new CustomEditor(tui, theme, keybindings)
		);
		record({
			kind: "session_start",
			sessionId,
			pid: process.pid,
			reason: event.reason,
			childViewCommandCount: pi.getCommands().filter(({ name }) => name === "child-view").length,
		});
	});
};

function record(value: Record<string, unknown>): void {
	const evidencePath = process.env.PROCESS_UI_PROBE_EVIDENCE;
	if (!evidencePath) return;
	appendFileSync(evidencePath, `${JSON.stringify(value)}\n`, { encoding: "utf8" });
}

export default processUiProbe;
