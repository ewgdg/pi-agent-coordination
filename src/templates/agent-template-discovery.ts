import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { extname, join } from "node:path";

import {
	AgentTemplateParseError,
	parseAgentTemplate,
} from "./agent-template-parser.ts";
import type {
	AgentTemplate,
	AgentTemplateDiagnostic,
	AgentTemplateDiscovery,
	AgentTemplateRoot,
	UnavailableAgentTemplate,
} from "./agent-templates.ts";

export async function discoverAgentTemplates(
	roots: readonly AgentTemplateRoot[],
): Promise<AgentTemplateDiscovery> {
	const templates = new Map<string, AgentTemplate>();
	const unavailable = new Map<string, UnavailableAgentTemplate>();
	const diagnostics: AgentTemplateDiagnostic[] = [];

	for (const root of roots) {
		const files = await discoverMarkdownFiles(root, diagnostics);
		const candidates = new Map<
			string,
			Array<Readonly<{ path: string; template?: AgentTemplate }>>
		>();
		for (const path of files) {
			try {
				const source = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path));
				const template = parseAgentTemplate(source, path);
				addCandidate(candidates, template.name, { path, template });
			} catch (error) {
				const templateName = error instanceof AgentTemplateParseError
					? error.templateName
					: undefined;
				diagnostics.push({
					scope: root.scope,
					path,
					message: error instanceof Error ? error.message : "failed to read Agent Template",
					...(templateName === undefined ? {} : { templateName }),
				});
				if (templateName !== undefined) addCandidate(candidates, templateName, { path });
			}
		}

		for (const [name, definitions] of candidates) {
			if (definitions.length > 1) {
				templates.delete(name);
				unavailable.set(name, {
					reason: "ambiguous",
					scope: root.scope,
					paths: definitions.map(({ path }) => path),
				});
				continue;
			}
			const definition = definitions[0];
			if (!definition?.template) {
				templates.delete(name);
				unavailable.set(name, {
					reason: "invalid",
					scope: root.scope,
					paths: definition ? [definition.path] : [],
				});
				continue;
			}
			templates.set(name, definition.template);
			unavailable.delete(name);
		}
	}

	return { templates, unavailable, diagnostics };
}

async function discoverMarkdownFiles(
	root: AgentTemplateRoot,
	diagnostics: AgentTemplateDiagnostic[],
): Promise<string[]> {
	const files: string[] = [];
	const visitedDirectories = new Set<string>();
	const visitedFiles = new Set<string>();

	async function walk(discoveryPath: string, optionalRoot = false): Promise<void> {
		let metadata;
		let canonicalPath;
		try {
			[metadata, canonicalPath] = await Promise.all([
				stat(discoveryPath),
				realpath(discoveryPath),
			]);
		} catch (error) {
			if (optionalRoot && isMissingPath(error)) return;
			diagnostics.push({
				scope: root.scope,
				path: discoveryPath,
				message: error instanceof Error ? error.message : "unreadable template path",
			});
			return;
		}

		if (metadata.isDirectory()) {
			if (visitedDirectories.has(canonicalPath)) return;
			visitedDirectories.add(canonicalPath);
			let entries;
			try {
				entries = await readdir(discoveryPath, { withFileTypes: true });
			} catch (error) {
				diagnostics.push({
					scope: root.scope,
					path: discoveryPath,
					message: error instanceof Error ? error.message : "unreadable template directory",
				});
				return;
			}
			for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
				await walk(join(discoveryPath, entry.name));
			}
			return;
		}

		if (!metadata.isFile() || extname(discoveryPath) !== ".md") return;
		if (visitedFiles.has(canonicalPath)) return;
		visitedFiles.add(canonicalPath);
		files.push(discoveryPath);
	}

	await walk(root.path, true);
	return files;
}

function addCandidate(
	candidates: Map<string, Array<Readonly<{ path: string; template?: AgentTemplate }>>>,
	name: string,
	candidate: Readonly<{ path: string; template?: AgentTemplate }>,
): void {
	const definitions = candidates.get(name) ?? [];
	definitions.push(candidate);
	candidates.set(name, definitions);
}

function isMissingPath(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
