import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("prototype-attention", {
		description: "Open a deterministic RPC input request for the Agent Run prototype",
		handler: async (_args, ctx) => {
			await ctx.ui.input("Agent Run prototype", "Enter any value to release attention");
		},
	});
}
