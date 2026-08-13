import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Type } from "typebox";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const REVERSE_BOUNDARY_ROOT_VARIABLE = "PROCESS_REVERSE_BOUNDARY_ROOT";

const BOUNDARY_WAIT_TIMEOUT_MILLISECONDS = 5_000;
const BOUNDARY_POLL_INTERVAL_MILLISECONDS = 10;

export default function registerReverseBoundaryTools(pi: ExtensionAPI): void {
	const parameters = Type.Object({}, { additionalProperties: false });
	for (const [name, method] of [
		["slow_boundary_tool", "slow"],
		["fast_boundary_tool", "fast"],
	] as const) {
		pi.registerTool({
			name,
			label: name,
			description: "Exercise the complete parallel tool boundary.",
			executionMode: "parallel",
			parameters,
			async execute() {
				const root = process.env[REVERSE_BOUNDARY_ROOT_VARIABLE];
				if (!root) throw new Error(`Missing ${REVERSE_BOUNDARY_ROOT_VARIABLE}`);
				await writeFile(
					join(root, `${method}-started.json`),
					`${JSON.stringify({ pid: process.pid })}\n`,
					{ encoding: "utf8", mode: 0o600 },
				);
				const releasePath = join(root, `${method}-release`);
				const deadline = Date.now() + BOUNDARY_WAIT_TIMEOUT_MILLISECONDS;
				while (Date.now() < deadline) {
					if (await access(releasePath).then(() => true, () => false)) break;
					await new Promise<void>((resolve) =>
						setTimeout(resolve, BOUNDARY_POLL_INTERVAL_MILLISECONDS)
					);
				}
				if (!await access(releasePath).then(() => true, () => false)) {
					throw new Error(`${method} boundary tool timed out waiting for release`);
				}
				return {
					content: [{ type: "text" as const, text: `${name} finished` }],
					details: undefined,
				};
			},
		});
	}
}
