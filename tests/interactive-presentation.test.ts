import assert from "node:assert/strict";
import test from "node:test";

import type {
	ExtensionUIContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

import { captureInteractivePresentation } from "../src/pi-integration/interactive-presentation.ts";

test("interactive presentation reinitializes through a public zero-line widget TUI", () => {
	const lifecycle: string[] = [];
	const tui = {
		stop(options?: { preserveScreen?: boolean }) {
			lifecycle.push(`stop:${String(options?.preserveScreen)}`);
		},
		start() {
			lifecycle.push("start");
		},
		requestRender(force?: boolean) {
			lifecycle.push(`render:${String(force)}`);
		},
	} as unknown as TUI;
	let captureWidget: Component | undefined;
	const ui = {
		setWidget(
			_key: string,
			factory: (tui: TUI, theme: Theme) => Component,
		) {
			captureWidget = factory(tui, {} as Theme);
		},
	} as unknown as ExtensionUIContext;

	const presentation = captureInteractivePresentation(ui);

	assert.deepEqual(captureWidget?.render(80), []);
	presentation.reinitialize();
	assert.deepEqual(lifecycle, ["stop:true", "start", "render:true"]);
});
