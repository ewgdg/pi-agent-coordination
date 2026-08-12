import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { childRuntimeInputs } from "./child-runtime-input-registry.ts";

/** Runs after inherited input preflights while delegating to the current bridge generation. */
const childRuntimeInput: ExtensionFactory = (pi) => {
	pi.on("input", (event, ctx) => {
		const handler = childRuntimeInputs.get(ctx.sessionManager);
		if (!handler) {
			throw new Error("child_runtime_input_unavailable: Runtime bridge is not bound");
		}
		return handler(event, ctx);
	});
};

export default childRuntimeInput;
