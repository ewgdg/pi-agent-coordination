import {
	InteractiveMode,
	type ExtensionFactory,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

import type { HumanQuestionAnswer } from "../../src/protocol/human-request.ts";
import { HumanRequestSurface } from "../../src/presentation/human-request-surface.ts";
import { createUnboundTestOwnerHost } from "../support/pi-host.ts";

const fixtureMode = process.argv[2];
if (fixtureMode !== "submit" && fixtureMode !== "interrupt") {
	throw new Error("Human Request PTY fixture requires submit or interrupt mode");
}

type Outcome =
	| Readonly<{ kind: "submit"; answers: readonly HumanQuestionAnswer[] }>
	| Readonly<{ kind: "interrupt" }>;

let resolveOutcome!: (outcome: Outcome) => void;
const outcomePromise = new Promise<Outcome>((resolve) => {
	resolveOutcome = resolve;
});
let activeUi: ExtensionUIContext | undefined;
let surface: HumanRequestSurface | undefined;
let activeFocus: Promise<void> | undefined;

const extension: ExtensionFactory = (pi) => {
	pi.registerShortcut("alt+h", {
		description: "Open the Human Request PTY fixture",
		handler() {
			if (!surface) throw new Error("Human Request PTY surface is unavailable");
			activeFocus = surface.focus("pty-human-request");
			return activeFocus;
		},
	});
	pi.on("session_start", (_event, ctx) => {
		activeUi = ctx.ui;
		ctx.ui.setEditorText("native draft");
		surface = new HumanRequestSurface(ctx.ui);
		surface.present(
			{
				requestId: "pty-human-request",
				agentId: "pty-child-agent",
				agentLabel: "agent",
				questionCount: fixtureMode === "submit" ? 3 : 1,
				request: {
					requestId: "pty-human-request",
					requesterAgentId: "pty-child-agent",
					source: {
						agentId: "pty-child-agent",
						entryId: "pty-source-entry",
						toolCallId: "pty-tool-call",
					},
					questions: fixtureMode === "submit"
						? [
							{
								kind: "select_one",
								header: "Architecture",
								prompt: "Choose the authoritative boundary.",
								options: [{ label: "Native Pi" }, { label: "Separate store" }],
								allowOther: false,
							},
							{
								kind: "text",
								header: "Rationale",
								prompt: "Explain the choice.",
								multiline: false,
							},
							{
								kind: "select_many",
								header: "Validation",
								prompt: "Choose the validation seams.",
								options: [{ label: "Real PTY" }, { label: "Reopened transcript" }],
								allowOther: false,
							},
						]
						: [{
							kind: "text",
							header: "Interrupt",
							prompt: "Press Escape to interrupt.",
							multiline: false,
						}],
				},
				submit(answers) {
					resolveOutcome({ kind: "submit", answers });
					return true;
				},
				ownsInteractiveSelection: () => false,
				interrupt() {
					resolveOutcome({ kind: "interrupt" });
				},
			},
			false,
		);
	});
};

const host = await createUnboundTestOwnerHost(extension);
const interactiveMode = new InteractiveMode(host.runtime, { verbose: false });
await interactiveMode.init();
const outcome = await outcomePromise;
await activeFocus;
if (!activeUi) throw new Error("Human Request PTY UI did not bind");
const result = {
	...outcome,
	editorText: activeUi.getEditorText(),
};
interactiveMode.stop();
await host.runtime.dispose();
process.stdout.write(`\n__PTY_RESULT__${JSON.stringify(result)}\n`);
