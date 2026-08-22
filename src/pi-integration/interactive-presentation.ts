import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Container, type TUI } from "@earendil-works/pi-tui";

import { terminalPresentationBarrierSequence } from "../process-runtime/terminal-presentation-barrier.ts";
import { IncompatiblePiHostError } from "./host-shape.ts";

export type InteractivePresentation = Readonly<{
	reinitialize(completionMarker: string): void;
	requestFullRender(): void;
}>;

const TUI_CAPTURE_WIDGET_KEY = "agent-coordination.interactive-tui-capture";

/** Capture Pi's stable public TUI reference without adding visible widget content. */
export function captureInteractivePresentation(
	ui: ExtensionUIContext,
): InteractivePresentation {
	let capturedTui: TUI | undefined;
	ui.setWidget(
		TUI_CAPTURE_WIDGET_KEY,
		(tui) => {
			assertInteractiveTui(tui);
			capturedTui = tui;
			return new Container();
		},
		{ placement: "aboveEditor" },
	);
	if (!capturedTui) {
		throw new IncompatiblePiHostError("ExtensionUIContext.setWidget TUI factory");
	}
	const tui = capturedTui;
	return {
		reinitialize(completionMarker) {
			// Restart and render synchronously so the in-band barrier is ordered after
			// every terminal mode and cell needed to reconstruct the complete frame.
			tui.stop({ preserveScreen: true });
			tui.start();
			tui.renderNow(true);
			tui.terminal.write(terminalPresentationBarrierSequence(completionMarker));
		},
		requestFullRender() {
			tui.requestRender(true);
		},
	};
}

function assertInteractiveTui(value: unknown): asserts value is TUI {
	if ((typeof value !== "object" && typeof value !== "function") || value === null) {
		throw new IncompatiblePiHostError("TUI");
	}
	for (const member of ["renderNow", "requestRender", "start", "stop"] as const) {
		if (typeof (value as Record<PropertyKey, unknown>)[member] !== "function") {
			throw new IncompatiblePiHostError(`TUI.${member}`);
		}
	}
	const terminal = (value as Record<PropertyKey, unknown>).terminal;
	if (
		typeof terminal !== "object"
		|| terminal === null
		|| typeof (terminal as Record<PropertyKey, unknown>).write !== "function"
	) {
		throw new IncompatiblePiHostError("TUI.terminal.write");
	}
}
