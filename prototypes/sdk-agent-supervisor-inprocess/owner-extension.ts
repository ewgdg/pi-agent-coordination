import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

import type { LiveSessionKey } from "./live-session-multiplexer.ts";
import { captureInteractiveRuntime } from "./runtime-capture.ts";
import { InProcessSupervisorCoordinator } from "./supervisor-coordinator.ts";

const STATUS_KEY = "sdk-agent-supervisor-inprocess";
const DEFAULT_HUMAN_REQUEST_PROMPT = "Which implementation should I use?";

let coordinatorPromise: Promise<InProcessSupervisorCoordinator> | undefined;

type CoordinatorResolver = (
	ctx: ExtensionContext,
) => Promise<InProcessSupervisorCoordinator | undefined>;

export function createSessionExtension(
	key: LiveSessionKey,
	getCoordinator: CoordinatorResolver = requireCoordinator,
): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		pi.registerCommand("agents", {
			description: "Switch among live Owner and child Agent sessions",
			handler: async (_args, ctx) => {
				const coordinator = await getCoordinator(ctx);
				if (coordinator) await coordinator.openAgentSelector(ctx);
			},
		});

		if (key !== "owner") {
			pi.registerCommand("prototype-human-request", {
				description: "Proof-only request for a Human Answer",
				handler: async (args, ctx) => {
					const coordinator = await getCoordinator(ctx);
					if (!coordinator) return;
					const prompt = args.trim() || DEFAULT_HUMAN_REQUEST_PROMPT;
					await coordinator.requestHumanAnswer(key, prompt);
				},
			});

			pi.on("input", async (event, ctx) => {
				if (event.source !== "interactive") return { action: "continue" };
				const coordinator = await getCoordinator(ctx);
				if (!coordinator?.pendingHumanRequest(key)) return { action: "continue" };
				if (event.images && event.images.length > 0) {
					ctx.ui.notify("Human Answers through the Agent editor must be text.", "warning");
					return { action: "handled" };
				}
				if (!coordinator.answerHumanRequest(key, event.text)) {
					ctx.ui.notify("That Human Request is no longer pending.", "warning");
				}
				return { action: "handled" };
			});
		}

		pi.on("session_start", async (_event, ctx) => {
			if (!ctx.hasUI || ctx.mode !== "tui") return;
			if (key === "owner") {
				ctx.ui.setStatus(STATUS_KEY, "Starting in-process SDK Agents…");
				coordinatorPromise ??= initializeCoordinator(pi, ctx);
			}
			const coordinator = await getCoordinator(ctx);
			coordinator?.mountSessionUI(key, ctx);
		});
	};
}

async function initializeCoordinator(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<InProcessSupervisorCoordinator> {
	try {
		const runtime = await captureInteractiveRuntime();
		return await InProcessSupervisorCoordinator.create(runtime, pi, ctx, createSessionExtension);
	} catch (error) {
		ctx.ui.setStatus(STATUS_KEY, `PROTOTYPE FAILED · ${String(error)}`);
		ctx.ui.notify(String(error), "error");
		throw error;
	}
}

async function requireCoordinator(
	ctx: ExtensionContext,
): Promise<InProcessSupervisorCoordinator | undefined> {
	if (!coordinatorPromise) {
		ctx.ui.notify("In-process Agent supervisor is not ready.", "warning");
		return undefined;
	}
	return coordinatorPromise;
}

export default function sdkAgentSupervisorInProcess(pi: ExtensionAPI): void {
	createSessionExtension("owner")(pi);
}
