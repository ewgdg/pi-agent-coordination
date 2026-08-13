import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getPackageDir } from "@earendil-works/pi-coding-agent";

import {
	materializeNewChildContextArtifact,
	renderChildContextArtifact,
} from "../src/process-runtime/child-context-artifact.ts";

const contextFiles = [
	{ path: "/project/AGENTS.md", content: "Project instructions" },
	{ path: "<agent-configuration:child>", content: "Configured context" },
] as const;

test("child context artifact reproduces Pi's ordered context-file system prompt", async () => {
	const systemPromptModule = await import(
		join(getPackageDir(), "dist", "core", "system-prompt.js")
	) as {
		buildSystemPrompt(options: Record<string, unknown>): string;
	};
	const direct = systemPromptModule.buildSystemPrompt({
		customPrompt: "base",
		cwd: "/project",
		contextFiles,
	});
	const materialized = systemPromptModule.buildSystemPrompt({
		customPrompt: "base",
		cwd: "/project",
		contextFiles: [],
		appendSystemPrompt: renderChildContextArtifact(contextFiles),
	});
	assert.equal(materialized, direct);
});

test("new child context artifact is immutable, private, and absent for empty context", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-agent-context-"));
	const artifactPath = join(directory, "context.md");
	assert.equal(
		await materializeNewChildContextArtifact({
			path: artifactPath,
			agentsFiles: [],
		}),
		undefined,
	);
	await assert.rejects(readFile(artifactPath), { code: "ENOENT" });

	assert.equal(
		await materializeNewChildContextArtifact({
			path: artifactPath,
			agentsFiles: contextFiles,
		}),
		artifactPath,
	);
	assert.equal(await readFile(artifactPath, "utf8"), renderChildContextArtifact(contextFiles));
	assert.equal((await stat(artifactPath)).mode & 0o777, 0o600);
	await assert.rejects(
		materializeNewChildContextArtifact({
			path: artifactPath,
			agentsFiles: contextFiles,
		}),
		{ code: "EEXIST" },
	);

	const relativePath = "relative-context.md";
	await assert.rejects(
		materializeNewChildContextArtifact({ path: relativePath, agentsFiles: contextFiles }),
		/absolute/,
	);
});
