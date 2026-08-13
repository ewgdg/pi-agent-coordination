import { access, writeFile } from "node:fs/promises";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const EXECUTION_GATE_STARTED_PATH_VARIABLE =
	"PROCESS_EXECUTION_GATE_STARTED_PATH";
export const EXECUTION_GATE_RELEASE_PATH_VARIABLE =
	"PROCESS_EXECUTION_GATE_RELEASE_PATH";

const GATE_WAIT_TIMEOUT_MILLISECONDS = 5_000;
const GATE_POLL_INTERVAL_MILLISECONDS = 10;

export default function registerExecutionGateTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "execution_gate",
		label: "Execution gate",
		description: "Hold one real hosted Agent execution at an observable tool boundary.",
		executionMode: "sequential",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute() {
			const startedPath = process.env[EXECUTION_GATE_STARTED_PATH_VARIABLE];
			const releasePath = process.env[EXECUTION_GATE_RELEASE_PATH_VARIABLE];
			if (!startedPath || !releasePath) {
				throw new Error("Missing process execution-gate paths");
			}
			await writeFile(
				startedPath,
				`${JSON.stringify({ pid: process.pid })}\n`,
				{ encoding: "utf8", mode: 0o600 },
			);
			const deadline = Date.now() + GATE_WAIT_TIMEOUT_MILLISECONDS;
			while (Date.now() < deadline) {
				if (await access(releasePath).then(() => true, () => false)) break;
				await new Promise<void>((resolve) =>
					setTimeout(resolve, GATE_POLL_INTERVAL_MILLISECONDS)
				);
			}
			if (!await access(releasePath).then(() => true, () => false)) {
				throw new Error("Process execution gate timed out waiting for release");
			}
			return {
				content: [{ type: "text" as const, text: "Execution gate released." }],
				details: undefined,
			};
		},
	});
}
