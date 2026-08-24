import { writeFileSync } from "node:fs";

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export const PI_CLI_READY_EVIDENCE_ENV = "PI_AGENT_COORDINATION_CLI_READY_EVIDENCE";

const piCliStartupReady: ExtensionFactory = (pi) => {
	pi.on("resources_discover", (event) => {
		// CLI extensions are inherited by child runtimes; only Owner startup gates input.
		if (
			event.reason !== "startup" ||
			process.env.PI_AGENT_COORDINATION_BOOTSTRAP !== undefined
		) return;
		const evidencePath = process.env[PI_CLI_READY_EVIDENCE_ENV];
		if (!evidencePath) return;
		writeFileSync(evidencePath, "ready\n", { encoding: "utf8" });
	});
};

export default piCliStartupReady;
