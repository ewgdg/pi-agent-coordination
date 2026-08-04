import assert from "node:assert/strict";
import test from "node:test";

import * as hostPi from "@earendil-works/pi-coding-agent";

import piAgentCoordination from "../src/index.ts";
import {
	assertHostModuleShape,
	IncompatiblePiHostError,
} from "../src/pi-integration/host-shape.ts";
import { installInteractiveHostBridge } from "../src/pi-integration/interactive-host-bridge.ts";
import { createUnboundTestOwnerHost } from "./support/pi-host.ts";

test("host preflight identifies a missing export without installing a patch", () => {
	const fixture = {
		...hostPi,
		createAgentSessionServices: undefined,
	};
	const originalSetRebindSession = fixture.AgentSessionRuntime.prototype.setRebindSession;

	assert.throws(
		() => installInteractiveHostBridge(fixture),
		(error: unknown) =>
			error instanceof IncompatiblePiHostError &&
			error.memberName === "createAgentSessionServices" &&
			error.message.includes(`running Pi ${hostPi.VERSION}`),
	);
	assert.equal(
		fixture.AgentSessionRuntime.prototype.setRebindSession,
		originalSetRebindSession,
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

test("host bridge installation remains idempotent across extension module reload", async () => {
	installInteractiveHostBridge(hostPi);
	const installedSetRebindSession = hostPi.AgentSessionRuntime.prototype.setRebindSession;
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
		hostPi.AgentSessionRuntime.prototype.setRebindSession,
		installedSetRebindSession,
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

	assert.throws(
		() => host.runtime.setRebindSession(async () => undefined),
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
