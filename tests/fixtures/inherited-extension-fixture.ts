import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const inheritedExtensionFixture: ExtensionFactory = (pi) => {
	pi.registerTool({
		name: "file_extension_probe",
		label: "File extension probe",
		description: "Proves that a file-backed extension loaded for this Run.",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute() {
			return {
				content: [{ type: "text", text: "file extension loaded" }],
				details: { loaded: true },
			};
		},
	});
};

export default inheritedExtensionFixture;
