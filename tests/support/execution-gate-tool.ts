import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const registryKey = Symbol.for("pi-agent-coordination.test.execution-gate");

export default function registerExecutionGateTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "execution_gate",
		label: "Execution gate",
		description: "Hold one real hosted Agent execution at an observable tool boundary.",
		executionMode: "sequential",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute() {
			const registry = (globalThis as Record<PropertyKey, unknown>)[registryKey] as
				| { execute(): Promise<void> }
				| undefined;
			if (!registry) throw new Error("Missing execution-gate operation");
			await registry.execute();
			return {
				content: [{ type: "text" as const, text: "Execution gate released." }],
				details: undefined,
			};
		},
	});
}
