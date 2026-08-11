import { writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

export type ChildContextFile = Readonly<{
	path: string;
	content: string;
}>;

/** Render Pi's ordered context-file section for --append-system-prompt. */
export function renderChildContextArtifact(
	agentsFiles: readonly ChildContextFile[],
): string | undefined {
	if (agentsFiles.length === 0) return undefined;
	validateAgentsFiles(agentsFiles);
	let content = "<project_context>\n\n";
	content += "Project-specific instructions and guidelines:\n\n";
	for (const file of agentsFiles) {
		content += `<project_instructions path="${file.path}">\n`;
		content += `${file.content}\n`;
		content += "</project_instructions>\n\n";
	}
	content += "</project_context>\n";
	return content;
}

/** Write one immutable owner-only context artifact before child launch. */
export async function materializeNewChildContextArtifact(options: {
	path: string;
	agentsFiles: readonly ChildContextFile[];
}): Promise<string | undefined> {
	if (!isAbsolute(options.path) || options.path.includes("\0")) {
		throw new Error("invalid_child_context_artifact: path must be absolute");
	}
	const content = renderChildContextArtifact(options.agentsFiles);
	if (content === undefined) return undefined;
	await writeFile(options.path, content, {
		encoding: "utf8",
		flag: "wx",
		mode: 0o600,
	});
	return options.path;
}

function validateAgentsFiles(agentsFiles: readonly ChildContextFile[]): void {
	const paths = new Set<string>();
	for (const file of agentsFiles) {
		if (file.path.length === 0 || file.path.includes("\0")) {
			throw new Error("invalid_child_context_artifact: context path is invalid");
		}
		if (typeof file.content !== "string") {
			throw new Error("invalid_child_context_artifact: context content is invalid");
		}
		if (paths.has(file.path)) {
			throw new Error("invalid_child_context_artifact: context paths contain duplicates");
		}
		paths.add(file.path);
	}
}
