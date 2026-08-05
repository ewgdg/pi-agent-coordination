import { Type } from "typebox";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const registryKey = Symbol.for("pi-agent-coordination.test.reverse-tools");

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
				const registry = (globalThis as Record<PropertyKey, unknown>)[registryKey] as
					| Record<typeof method, () => Promise<void>>
					| undefined;
				const operation = registry?.[method];
				if (!operation) throw new Error(`Missing ${method} boundary-tool operation`);
				await operation();
				return {
					content: [{ type: "text" as const, text: `${name} finished` }],
					details: undefined,
				};
			},
		});
	}
}
