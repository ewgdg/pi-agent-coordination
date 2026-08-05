import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import * as hostAi from "@earendil-works/pi-ai";
import * as hostPi from "@earendil-works/pi-coding-agent";
import * as hostTui from "@earendil-works/pi-tui";
import * as hostTypebox from "typebox";

import piAgentCoordination from "../src/index.ts";
import {
	assertHostModuleShape,
	assertPiAiModuleShape,
	assertTuiModuleShape,
	assertTypeboxModuleShape,
	IncompatiblePiHostError,
} from "../src/pi-integration/host-shape.ts";
import { installInteractiveHostBridge } from "../src/pi-integration/interactive-host-bridge.ts";
import { bindTestOwnerHost, createUnboundTestOwnerHost } from "./support/pi-host.ts";

type InteractivePrototype = {
	bindCurrentSessionExtensions(): Promise<void>;
};

test("the package declares exactly the Pi host modules imported by production", async () => {
	const manifest = JSON.parse(
		await readFile(new URL("../package.json", import.meta.url), "utf8"),
	) as {
		dependencies?: Record<string, string>;
		peerDependencies?: Record<string, string>;
	};
	const expectedHostPeers = {
		"@earendil-works/pi-agent-core": "*",
		"@earendil-works/pi-ai": "*",
		"@earendil-works/pi-coding-agent": "*",
		"@earendil-works/pi-tui": "*",
		typebox: "*",
	};

	assert.deepEqual(manifest.peerDependencies, expectedHostPeers);
	for (const hostModule of Object.keys(expectedHostPeers)) {
		assert.equal(manifest.dependencies?.[hostModule], undefined);
	}
});

test("host preflight identifies a missing export without installing a patch", () => {
	const fixture = {
		...hostPi,
		createAgentSessionServices: undefined,
	};
	const interactivePrototype = fixture.InteractiveMode
		.prototype as unknown as InteractivePrototype;
	const originalBindCurrentSessionExtensions =
		interactivePrototype.bindCurrentSessionExtensions;

	assert.throws(
		() => installInteractiveHostBridge(fixture),
		(error: unknown) =>
			error instanceof IncompatiblePiHostError &&
			error.memberName === "createAgentSessionServices" &&
			error.message.includes(`running Pi ${hostPi.VERSION}`),
	);
	assert.equal(
		interactivePrototype.bindCurrentSessionExtensions,
		originalBindCurrentSessionExtensions,
	);
});

test("host preflight identifies a malformed private seam by canonical name", () => {
	function MalformedInteractiveMode() {}
	MalformedInteractiveMode.prototype = Object.create(hostPi.InteractiveMode.prototype, {
		getUserInput: { configurable: true, value: undefined },
	});
	const fixture = { ...hostPi, InteractiveMode: MalformedInteractiveMode };

	assert.throws(
		() => assertHostModuleShape(fixture),
		(error: unknown) =>
			error instanceof IncompatiblePiHostError &&
			error.memberName === "InteractiveMode.prototype.getUserInput",
	);
});

test("host preflight validates every running-host TUI value used by presentation", () => {
	const fixture = { ...hostTui, wrapTextWithAnsi: undefined };

	assert.throws(
		() => assertTuiModuleShape(fixture, hostPi.VERSION),
		(error: unknown) =>
			error instanceof IncompatiblePiHostError &&
			error.memberName === "PiTUI.wrapTextWithAnsi" &&
			error.message.includes(`running Pi ${hostPi.VERSION}`),
	);
});

test("host preflight validates running-host AI and schema values", () => {
	assert.throws(
		() => assertPiAiModuleShape(
			{ ...hostAi, createAssistantMessageEventStream: undefined },
			hostPi.VERSION,
		),
		(error: unknown) =>
			error instanceof IncompatiblePiHostError &&
			error.memberName === "PiAI.createAssistantMessageEventStream",
	);
	assert.throws(
		() => assertTypeboxModuleShape(
			{ ...hostTypebox, Type: { ...hostTypebox.Type, Object: undefined } },
			hostPi.VERSION,
		),
		(error: unknown) =>
			error instanceof IncompatiblePiHostError &&
			error.memberName === "TypeBox.Type.Object",
	);
});

test("host bridge installation remains idempotent across extension module reload", async () => {
	installInteractiveHostBridge(hostPi);
	const interactivePrototype = hostPi.InteractiveMode
		.prototype as unknown as InteractivePrototype;
	const installedBindCurrentSessionExtensions =
		interactivePrototype.bindCurrentSessionExtensions;
	const reloadedModuleUrl = new URL(
		"../src/pi-integration/interactive-host-bridge.ts",
		import.meta.url,
	);
	reloadedModuleUrl.searchParams.set("reload", "regression");
	const reloadedBridgeModule = (await import(reloadedModuleUrl.href)) as typeof import(
		"../src/pi-integration/interactive-host-bridge.ts"
	);

	reloadedBridgeModule.installInteractiveHostBridge(hostPi);

	assert.equal(
		interactivePrototype.bindCurrentSessionExtensions,
		installedBindCurrentSessionExtensions,
	);
});

test("runtime capture rejects a malformed live AgentSession before bootstrap", async () => {
	const host = await createUnboundTestOwnerHost(piAgentCoordination);
	const originalSendCustomMessage = host.session.sendCustomMessage;
	Object.defineProperty(host.session, "sendCustomMessage", {
		configurable: true,
		value: undefined,
	});
	host.runtime.setBeforeSessionInvalidate(() => undefined);

	await assert.rejects(
		() => bindTestOwnerHost(host, "tui"),
		(error: unknown) =>
			error instanceof IncompatiblePiHostError &&
			error.memberName === "AgentSession.sendCustomMessage",
	);
	assert.equal(
		host.session.sessionManager
			.getEntries()
			.some(
				(entry) =>
					entry.type === "custom" && entry.customType === "agent-coordination.identity",
			),
		false,
	);
	Object.defineProperty(host.session, "sendCustomMessage", {
		configurable: true,
		value: originalSendCustomMessage,
	});
	await host.runtime.dispose();
});

test("runtime capture identifies the coordinated settings override seam", async () => {
	const host = await createUnboundTestOwnerHost(piAgentCoordination);
	const settings = host.services.settingsManager as unknown as Record<PropertyKey, unknown>;
	const originalApplyOverrides = settings.applyOverrides;
	settings.applyOverrides = undefined;
	host.runtime.setBeforeSessionInvalidate(() => undefined);

	await assert.rejects(
		() => bindTestOwnerHost(host, "tui"),
		(error: unknown) =>
			error instanceof IncompatiblePiHostError &&
			error.memberName === "AgentSessionRuntime.services.settingsManager.applyOverrides",
	);
	settings.applyOverrides = originalApplyOverrides;
	await host.runtime.dispose();
});

test("runtime capture rejects transport incompatibility before Owner bootstrap", async () => {
	const host = await createUnboundTestOwnerHost(piAgentCoordination);
	const settings = host.services.settingsManager as unknown as Record<PropertyKey, unknown>;
	const originalGetTransport = settings.getTransport;
	settings.getTransport = undefined;
	host.runtime.setBeforeSessionInvalidate(() => undefined);

	await assert.rejects(
		() => bindTestOwnerHost(host, "tui"),
		(error: unknown) =>
			error instanceof IncompatiblePiHostError &&
			error.memberName === "AgentSessionRuntime.services.settingsManager.getTransport",
	);
	assert.equal(
		host.session.sessionManager
			.getEntries()
			.some(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === "agent-coordination.identity",
			),
		false,
	);
	settings.getTransport = originalGetTransport;
	await host.runtime.dispose();
});

test("runtime capture identifies the provider stream adapter seam", async () => {
	const host = await createUnboundTestOwnerHost(piAgentCoordination);
	const agent = host.session.agent as unknown as Record<PropertyKey, unknown>;
	const originalStreamFunction = agent.streamFunction;
	agent.streamFunction = undefined;
	host.runtime.setBeforeSessionInvalidate(() => undefined);

	await assert.rejects(
		() => bindTestOwnerHost(host, "tui"),
		(error: unknown) =>
			error instanceof IncompatiblePiHostError &&
			error.memberName === "AgentSession.agent.streamFunction",
	);
	agent.streamFunction = originalStreamFunction;
	await host.runtime.dispose();
});
