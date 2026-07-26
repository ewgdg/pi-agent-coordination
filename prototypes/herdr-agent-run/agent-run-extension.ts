import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BLOCKED_EVENT = "herdr:blocked";
const DEFAULT_STEER_MESSAGE = "Stop the current approach and wait for further instructions.";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("agent-run-prototype", "PROTOTYPE READY — interactive Pi");
	});

	pi.registerCommand("prototype-request", {
		description: "Open a Human Request in the normal Pi panel",
		handler: async (_args, ctx) => {
			pi.events.emit(BLOCKED_EVENT, {
				active: true,
				label: "Waiting for prototype Human Answer",
			});
			try {
				const answer = await ctx.ui.input(
					"Prototype Human Request",
					"Enter an answer in this Pi panel",
				);
				ctx.ui.notify(answer ? `Answer received: ${answer}` : "Request cancelled", "info");
			} finally {
				pi.events.emit(BLOCKED_EVENT, { active: false });
			}
		},
	});

	pi.registerCommand("prototype-steer", {
		description: "Queue a semantic steering message through Pi",
		handler: async (args, ctx) => {
			const message = args.trim() || DEFAULT_STEER_MESSAGE;
			if (ctx.isIdle()) {
				ctx.ui.notify("Start work before testing steer", "warning");
				return;
			}
			pi.sendUserMessage(message, { deliverAs: "steer" });
			ctx.ui.notify("Steering message queued by Pi", "info");
		},
	});

	pi.registerCommand("prototype-abort", {
		description: "Abort current work through Pi semantics",
		handler: async (_args, ctx) => {
			ctx.abort();
			ctx.ui.notify("Abort requested through Pi", "info");
		},
	});

	pi.registerCommand("prototype-shutdown", {
		description: "Ask Pi to terminate itself gracefully",
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});
}
