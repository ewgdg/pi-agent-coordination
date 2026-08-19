import { writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

/** Write one immutable owner-only explicit system-prompt artifact. */
export async function materializeNewChildSystemPromptArtifact(options: {
	path: string;
	body: string;
}): Promise<string> {
	if (!isAbsolute(options.path) || options.path.includes("\0")) {
		throw new Error("invalid_child_system_prompt_artifact: path must be absolute");
	}
	if (typeof options.body !== "string") {
		throw new Error("invalid_child_system_prompt_artifact: body must be a string");
	}
	await writeFile(options.path, options.body, {
		encoding: "utf8",
		flag: "wx",
		mode: 0o600,
	});
	return options.path;
}
