import assert from "node:assert/strict";
import test from "node:test";

import piAgentCoordination from "../src/index.ts";
import {
	bindTestOwnerHost,
	createUnboundTestOwnerHost,
} from "./support/pi-host.ts";

test("print, JSON, and RPC modes expose no coordination runtime surface", async (t) => {
	for (const mode of ["print", "json", "rpc"] as const) {
		await t.test(mode, async () => {
			const host = await createUnboundTestOwnerHost(piAgentCoordination);
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
