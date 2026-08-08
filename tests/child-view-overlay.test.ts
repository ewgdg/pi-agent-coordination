import assert from "node:assert/strict";
import test from "node:test";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

import piAgentCoordination from "../src/index.ts";
import {
	ChildViewOverlayComponent,
	createChildViewShadowHost,
	openChildViewOverlay,
} from "../src/presentation/child-view-overlay.ts";
import {
	createTestOwnerHost,
	type TestOwnerHost,
} from "./support/pi-host.ts";

const RENDER_WIDTH = 100;
const TEST_TUI_ROWS = 24;

function quietTui(ui: TUI): TUI {
	// Neutered render pump: no terminal writes, no Owner chrome side effects.
	const facade = Object.create(ui) as TUI & { terminal: TUI["terminal"] };
	facade.requestRender = () => undefined;
	facade.terminal = new Proxy(ui.terminal, {
		get(target, property, receiver) {
			if (property === "setProgress") return () => undefined;
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return facade;
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error("condition not reached within 5s");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function scriptTextOnlyTranscript(host: TestOwnerHost): Promise<void> {
	host.model.setResponses([
		fauxAssistantMessage("First scripted assistant reply."),
	]);
	await host.session.prompt("First scripted user question.");
	host.model.setResponses([
		fauxAssistantMessage("Second scripted assistant reply with **markdown**."),
	]);
	await host.session.prompt("Second scripted user question.");
}

test("shadow host renders the same transcript as the native InteractiveMode (parity diff)", async () => {
	const host = await createTestOwnerHost(piAgentCoordination);
	await scriptTextOnlyTranscript(host);
	// Mermaid parity probe: the shadow runs the real ctor, so the real mermaid
	// transformer must render the same ASCII diagram as native.
	host.model.setResponses([
		fauxAssistantMessage(
			"Third reply with a diagram:\n```mermaid\ngraph TD\nA[Start] --> B[End]\n```",
		),
	]);
	await host.session.prompt("Third scripted user question.");

	const native = new InteractiveMode(host.runtime, { verbose: false });
	// The constructed-but-unmounted mode must not write to the test terminal;
	// swap only its render pump, keeping every other native field intact.
	const nativeUi = (native as unknown as { ui: TUI }).ui;
	(native as unknown as { ui: TUI }).ui = quietTui(nativeUi);

	const entries = host.session.sessionManager.buildContextEntries();
	(native as unknown as {
		renderSessionEntries(entries: readonly unknown[]): void;
	}).renderSessionEntries(entries);
	const shadow = createChildViewShadowHost({
		interactiveModeClass: InteractiveMode,
		session: host.session,
		tui: quietTui(nativeUi),
	});
	shadow.renderSessionEntries(entries);

	const nativeLines = (native as unknown as { chatContainer: Component })
		.chatContainer.render(RENDER_WIDTH);
	const shadowLines = shadow.chatContainer.render(RENDER_WIDTH);

	assert.ok(nativeLines.length > 0, "scripted transcript rendered natively");
	assert.ok(
		nativeLines.some((line) => line.includes("Start")) &&
			nativeLines.some((line) => line.includes("End")),
		"mermaid block rendered as a diagram by the native transformer",
	);
	assert.deepEqual(
		shadowLines,
		nativeLines,
		"overlay shadow render must match the native render line-for-line",
	);
});

async function openSurface(
	host: TestOwnerHost,
): Promise<{ surface: ChildViewOverlayComponent; opened: Promise<"closed"> }> {
	const opened = openChildViewOverlay({
		interactiveModeClass: InteractiveMode,
		ui: host.ui,
		session: host.session,
		agentLabel: "test-child",
	});
	await waitForCondition(() => host.ui.customSurfaces.length === 1);
	const surface = host.ui.customSurfaces[0];
	if (!(surface instanceof ChildViewOverlayComponent)) {
		throw new Error("expected the overlay surface to be a ChildViewOverlayComponent");
	}
	return { surface, opened };
}

test("overlay opens full-window, renders the transcript, Escape closes", async () => {
	const host = await createTestOwnerHost(piAgentCoordination);
	await scriptTextOnlyTranscript(host);

	const { surface, opened } = await openSurface(host);

	// Constant full-screen height: every render emits exactly `terminal.rows`
	// lines, so the TUI's differential renderer never sees a height change.
	const lines = surface.render(80);
	assert.equal(lines.length, TEST_TUI_ROWS);
	assert.match(lines[0]!, /CHILD VIEW · test-child/);
	assert.ok(
		lines.some((line) => line.includes("First scripted user question.")),
		"initial child transcript is rendered",
	);
	assert.ok(
		lines.some((line) => line.includes("First scripted assistant reply.")),
		"initial child transcript is rendered",
	);

	// Escape closes the overlay; focus returns to the Owner's editor (the
	// overlay is disposed and the `custom` promise resolves).
	surface.handleInput("\x1b");
	assert.equal(await opened, "closed");
	assert.equal(host.ui.customSurfaces.length, 0);
});

test("overlay render height is constant across content growth (no redraw artifacts)", async () => {
	const host = await createTestOwnerHost(piAgentCoordination);
	await scriptTextOnlyTranscript(host);

	const { surface, opened } = await openSurface(host);
	const before = surface.render(80);

	// Stream a third message while the overlay is open.
	host.model.setResponses([
		fauxAssistantMessage("Third scripted assistant reply while streaming."),
	]);
	await host.session.prompt("Third scripted user question while streaming.");
	await host.session.waitForIdle();

	const after = surface.render(80);
	assert.equal(after.length, TEST_TUI_ROWS);
	assert.equal(before.length, after.length);
	assert.ok(after.some((line) => line.includes("Third scripted assistant reply")));
	assert.notDeepEqual(
		after,
		before,
		"streaming grows content inside the fixed-height overlay",
	);
	surface.handleInput("\x1b");
	assert.equal(await opened, "closed");
});
