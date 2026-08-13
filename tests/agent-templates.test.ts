import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { discoverAgentTemplates } from "../src/templates/agent-template-discovery.ts";
import { parseAgentTemplate } from "../src/templates/agent-template-parser.ts";
import { selectAgentTemplateForRun } from "../src/templates/agent-templates.ts";
import { resolveAgentRunConfiguration } from "../src/templates/agent-configuration.ts";
import {
	resolveModeratorAgentMetadata,
	resolveOrdinaryAgentMetadata,
	resolveOwnerAgentMetadata,
} from "../src/protocol/agent-metadata.ts";

test("parses the complete strict Agent Template surface", () => {
	const template = parseAgentTemplate(
		[
			"---",
			"name: research-agent",
			"model: coordination-test/deterministic-child",
			"thinking: high",
			"tools: read, grep",
			"skills:",
			"  - research",
			"extensions: none",
			"project-context: replace",
			"---",
			"Use primary sources.",
		].join("\n"),
		"/templates/research-agent.md",
	);

	assert.deepEqual(template, {
		name: "research-agent",
		model: {
			provider: "coordination-test",
			modelId: "deterministic-child",
		},
		thinking: "high",
		tools: ["read", "grep"],
		skills: ["research"],
		extensions: "none",
		projectContextMode: "replace",
		projectContext: "Use primary sources.",
		sourcePath: "/templates/research-agent.md",
	});
});

test("rejects YAML capabilities, coercion, and fields outside the Agent Template contract", () => {
	const invalidTemplates = [
		"---\nname: research-agent\ndescription: forbidden\n---\n",
		"---\nname: research-agent\ntools: read\ntools: grep\n---\n",
		"---\nname: research-agent\ntools: &tools [read]\nskills: *tools\n---\n",
		"---\nname: research-agent\ntools: !selected read\n---\n",
		"---\nname: research-agent\ntools: true\n---\n",
		"name: research-agent\n",
	];
	for (const [index, source] of invalidTemplates.entries()) {
		assert.throws(
			() => parseAgentTemplate(source, `/templates/invalid-${index}.md`),
			/Invalid Agent Template/,
		);
	}
});

test("discovers whole templates by strict precedence while safely following symlinks", async () => {
	const fixture = await mkdtemp(join(tmpdir(), "agent-template-discovery-"));
	const packageRoot = join(fixture, "package");
	const projectRoot = join(fixture, "project");
	await mkdir(join(packageRoot, "nested"), { recursive: true });
	await mkdir(projectRoot, { recursive: true });
	await writeFile(
		join(packageRoot, "nested", "research.md"),
		"---\nname: research-agent\ntools: read, grep\n---\nPackage context",
	);
	await writeFile(
		join(packageRoot, "blocked.md"),
		"---\nname: blocked-agent\nthinking: low\n---\n",
	);
	await writeFile(
		join(packageRoot, "duplicate-name.md"),
		"---\nname: duplicate-name-agent\nthinking: low\n---\n",
	);
	await writeFile(
		join(projectRoot, "research.md"),
		"---\nname: research-agent\nthinking: high\n---\nProject context",
	);
	await writeFile(
		join(projectRoot, "blocked.md"),
		"---\nname: blocked-agent\ncwd: elsewhere\n---\n",
	);
	await writeFile(
		join(projectRoot, "duplicate-a.md"),
		"---\nname: duplicate-agent\n---\n",
	);
	await writeFile(
		join(projectRoot, "duplicate-b.md"),
		"---\nname: duplicate-agent\n---\n",
	);
	await writeFile(
		join(projectRoot, "duplicate-name.md"),
		"---\nname: duplicate-name-agent\nname: duplicate-name-agent\n---\n",
	);
	const invalidUtf8Path = join(projectRoot, "invalid-utf8.md");
	await writeFile(invalidUtf8Path, Uint8Array.from([0xff, 0xfe]));
	const brokenSymlinkPath = join(projectRoot, "broken.md");
	await symlink(join(projectRoot, "missing.md"), brokenSymlinkPath, "file");
	await symlink(
		join(projectRoot, "research.md"),
		join(projectRoot, "zz-research-alias.md"),
		"file",
	);
	await symlink(packageRoot, join(packageRoot, "nested", "cycle"), "dir");

	const discovery = await discoverAgentTemplates([
		{ scope: "package", path: packageRoot },
		{ scope: "project", path: projectRoot },
	]);

	assert.deepEqual(discovery.templates.get("research-agent"), {
		name: "research-agent",
		thinking: "high",
		projectContextMode: "append",
		projectContext: "Project context",
		sourcePath: join(projectRoot, "research.md"),
	});
	assert.equal(discovery.templates.has("blocked-agent"), false);
	assert.equal(discovery.unavailable.get("blocked-agent")?.reason, "invalid");
	assert.equal(discovery.templates.has("duplicate-agent"), false);
	assert.equal(discovery.unavailable.get("duplicate-agent")?.reason, "ambiguous");
	assert.equal(discovery.templates.has("duplicate-name-agent"), false);
	assert.equal(discovery.unavailable.get("duplicate-name-agent")?.reason, "invalid");
	assert.ok(discovery.diagnostics.some(({ path }) => path === invalidUtf8Path));
	assert.ok(discovery.diagnostics.some(({ path }) => path === brokenSymlinkPath));
});

test("resolves inherited Runtime values, current template, explicit spawn overrides, and fixed role tools in order", () => {
	const configuration = resolveAgentRunConfiguration({
		inherited: {
			cwd: "/baseline/project",
			model: { provider: "base", modelId: "model" },
			thinking: "low",
			tools: ["bash"],
			skills: ["base-skill"],
			extensions: ["/extensions/base.ts"],
		},
		template: {
			name: "research-agent",
			model: { provider: "template", modelId: "model" },
			tools: ["read"],
			projectContextMode: "replace",
			projectContext: "Template context",
			sourcePath: "/templates/research.md",
		},
		overrides: {
			thinking: "high",
			cwd: "subproject",
			tools: [],
			extensions: "inherit",
			projectContext: "Spawn context",
			projectContextMode: "append",
		},
		fixedTools: ["agent_message", "agent_spawn"],
	});

	assert.deepEqual(configuration, {
		cwd: "/baseline/project/subproject",
		model: { provider: "template", modelId: "model" },
		thinking: "high",
		tools: ["agent_message", "agent_spawn"],
		skills: ["base-skill"],
		extensions: ["/extensions/base.ts"],
		projectContext: {
			mode: "replace",
			body: "Template context\n\nSpawn context",
		},
	});
});

test("resolves normalized ordinary Agent metadata without inheriting or weakening explicit values", () => {
	assert.deepEqual(
		resolveOrdinaryAgentMetadata({
			explicitLabel: "  研究 agent  ",
			explicitDescription: "  Primary-source research  ",
			templateName: "template-label",
		}),
		{
			label: "研究 agent",
			description: "Primary-source research",
		},
	);
	assert.deepEqual(resolveOrdinaryAgentMetadata({ templateName: "template-label" }), {
		label: "template-label",
	});
	assert.deepEqual(resolveOrdinaryAgentMetadata({}), { label: "agent" });
	assert.throws(
		() => resolveOrdinaryAgentMetadata({ explicitLabel: "  ", templateName: "fallback" }),
		/Agent label must not be empty/,
	);
	assert.throws(
		() => resolveOrdinaryAgentMetadata({ explicitLabel: "🙂".repeat(65) }),
		/exceeds 64 Unicode code points/,
	);
	assert.throws(
		() => resolveOrdinaryAgentMetadata({ explicitLabel: "research\u2028agent" }),
		/line breaks or control characters/,
	);
});

test("resolves fixed Owner and Moderator role metadata", () => {
	assert.deepEqual(resolveOwnerAgentMetadata(), {
		label: "owner",
		description: "workflow owner",
	});
	assert.deepEqual(resolveModeratorAgentMetadata("run_failure"), {
		label: "moderator",
		description: "moderating run failure",
	});
	assert.deepEqual(resolveModeratorAgentMetadata("obligation_stall"), {
		label: "moderator",
		description: "moderating obligation stall",
	});
	assert.deepEqual(resolveModeratorAgentMetadata("dependency_deadlock"), {
		label: "moderator",
		description: "moderating dependency deadlock",
	});
	assert.deepEqual(resolveModeratorAgentMetadata("operation_review"), {
		label: "moderator",
		description: "moderating operation review",
	});
});

test("permits only the missing reserved Moderator Template", () => {

	const discovery = {
		templates: new Map(),
		unavailable: new Map(),
		diagnostics: [],
	};
	assert.equal(selectAgentTemplateForRun(discovery, "moderator"), undefined);
	assert.throws(
		() => selectAgentTemplateForRun(discovery, "missing-agent"),
		/Selected Agent Template missing-agent is missing/,
	);
});
