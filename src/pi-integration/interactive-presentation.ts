import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Container, type TUI } from "@earendil-works/pi-tui";

import { IncompatiblePiHostError } from "./host-shape.ts";

export type InteractivePresentation = Readonly<{
	reinitialize(): void;
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
		reinitialize() {
			// Restart the exact child TUI so Pi itself replays terminal modes and a
			// complete frame when physical attachment changes.
			tui.stop({ preserveScreen: true });
			tui.start();
			tui.requestRender(true);
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
	for (const member of ["requestRender", "start", "stop"] as const) {
		if (typeof (value as Record<PropertyKey, unknown>)[member] !== "function") {
			throw new IncompatiblePiHostError(`TUI.${member}`);
		}
	}
}
