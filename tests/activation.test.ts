import assert from "node:assert/strict";
import test from "node:test";

import * as hostPi from "@earendil-works/pi-coding-agent";

import piAgentCoordination from "../src/index.ts";
import {
	bindTestOwnerHost,
	createUnboundTestOwnerHost,
} from "./support/pi-host.ts";

test("print, JSON, and RPC modes expose no coordination runtime surface", async (t) => {
	const nativeSetRebindSession = hostPi.AgentSessionRuntime.prototype.setRebindSession;
	for (const mode of ["print", "json", "rpc"] as const) {
		await t.test(mode, async () => {
			const host = await createUnboundTestOwnerHost(piAgentCoordination);
			assert.equal(
				hostPi.AgentSessionRuntime.prototype.setRebindSession,
				nativeSetRebindSession,
			);
			host.runtime.setRebindSession(async () => undefined);
			await bindTestOwnerHost(host, mode);

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
			assert.equal(host.session.getToolDefinition("agent_observe"), undefined);
			assert.equal(host.session.extensionRunner.getCommand("agents"), undefined);
			await host.runtime.dispose();
		});
	}
});

test("headless startup never admits or inspects a malformed interactive runtime", async () => {
	const host = await createUnboundTestOwnerHost(piAgentCoordination);
	const originalSendCustomMessage = host.session.sendCustomMessage;
	Object.defineProperty(host.session, "sendCustomMessage", {
		configurable: true,
		value: undefined,
	});

	host.runtime.setRebindSession(async () => undefined);
	await bindTestOwnerHost(host, "print");

	assert.equal(host.session.getToolDefinition("agent_observe"), undefined);
	assert.equal(host.session.extensionRunner.getCommand("agents"), undefined);
	Object.defineProperty(host.session, "sendCustomMessage", {
		configurable: true,
		value: originalSendCustomMessage,
	});
	await host.runtime.dispose();
});
