import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { discoverAgentTemplates } from "../src/templates/agent-template-discovery.ts";
import { parseAgentTemplate } from "../src/templates/agent-template-parser.ts";
import {
	createAgentTemplateCatalogue,
	selectAgentTemplateForRun,
} from "../src/templates/agent-templates.ts";
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
			"selection-guide: Use for primary-source research.",
			"models:",
			"  - id: coordination-test/deterministic-child",
			"    thinking: high",
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
		selectionGuide: "Use for primary-source research.",
		models: [{
			model: { provider: "coordination-test", modelId: "deterministic-child" },
			thinking: "high",
		}],
		tools: ["read", "grep"],
		skills: ["research"],
		extensions: "none",
		projectContextMode: "replace",
		projectContext: "Use primary sources.",
		sourcePath: "/templates/research-agent.md",
	});
});

test("rejects extension path arrays outside the Agent Template contract", () => {
	assert.throws(
		() => parseAgentTemplate(
			"---\nname: research-agent\nselection-guide: Use for research.\nextensions:\n  - /extensions/arbitrary.ts\n---\n",
			"/templates/research-agent.md",
		),
		/extensions must be "inherit" or "none"/,
	);
});

test("allows an absent selection guide but rejects a blank one", () => {
	assert.deepEqual(
		parseAgentTemplate(
			"---\nname: research-agent\n---\n",
			"/templates/research-agent.md",
		),
		{
			name: "research-agent",
			projectContextMode: "append",
			projectContext: "",
			sourcePath: "/templates/research-agent.md",
		},
	);
	assert.throws(
		() => parseAgentTemplate(
			"---\nname: research-agent\nselection-guide: '   '\n---\n",
			"/templates/research-agent.md",
		),
		/selection-guide must be a nonblank string/,
	);
});

test("parses ordered model and thinking fallback candidates", () => {
	const template = parseAgentTemplate(
		[
			"---",
			"name: cheap-delegate",
			"models:",
			"  - id: codex-lb/gpt-5.6-luna",
			"    thinking: max",
			"  - id: deepseek/deepseek-v4-flash",
			"    thinking: high",
			"---",
		].join("\n"),
		"/templates/cheap-delegate.md",
	);

	assert.deepEqual(template.models, [
		{ model: { provider: "codex-lb", modelId: "gpt-5.6-luna" }, thinking: "max" },
		{ model: { provider: "deepseek", modelId: "deepseek-v4-flash" }, thinking: "high" },
	]);
});

test("rejects top-level Template model and thinking fields", () => {
	for (const field of ["model: provider/model", "thinking: high"]) {
		assert.throws(
			() => parseAgentTemplate(
				`---\nname: invalid-agent\n${field}\n---\n`,
				"/templates/invalid-agent.md",
			),
			/unknown frontmatter field/,
		);
	}
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
		"---\nname: research-agent\nselection-guide: Use for research.\ntools: read, grep\n---\nPackage context",
	);
	await writeFile(
		join(packageRoot, "blocked.md"),
		"---\nname: blocked-agent\nselection-guide: Use when blocked.\n---\n",
	);
	await writeFile(
		join(packageRoot, "duplicate-name.md"),
		"---\nname: duplicate-name-agent\nselection-guide: Use for duplicate checks.\n---\n",
	);
	await writeFile(
		join(projectRoot, "research.md"),
		"---\nname: research-agent\nselection-guide: Use for research.\nmodels:\n  - id: research/model\n    thinking: high\n---\nProject context",
	);
	await writeFile(
		join(projectRoot, "blocked.md"),
		"---\nname: blocked-agent\nselection-guide: Use when blocked.\ncwd: elsewhere\n---\n",
	);
	await writeFile(
		join(projectRoot, "duplicate-a.md"),
		"---\nname: duplicate-agent\nselection-guide: Use for duplicates.\n---\n",
	);
	await writeFile(
		join(projectRoot, "duplicate-b.md"),
		"---\nname: duplicate-agent\nselection-guide: Use for duplicates.\n---\n",
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
		selectionGuide: "Use for research.",
		models: [{
			model: { provider: "research", modelId: "model" },
			thinking: "high",
		}],
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
	assert.deepEqual(
		createAgentTemplateCatalogue(discovery.templates.values()).map(({ name }) => name),
		["research-agent"],
	);
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
			selectionGuide: "Use for research.",
			models: [
				{ model: { provider: "missing", modelId: "model" }, thinking: "low" },
				{ model: { provider: "template", modelId: "model" }, thinking: "medium" },
			],
			tools: ["read"],
			projectContextMode: "replace",
			projectContext: "Template context",
			sourcePath: "/templates/research.md",
		},
		overrides: {
			cwd: "subproject",
			tools: [],
			extensions: "inherit",
			projectContext: "Spawn context",
			projectContextMode: "append",
		},
		fixedTools: ["agent_message", "agent_spawn"],
		isModelAvailable: ({ provider }) => provider === "template",
	});

	assert.deepEqual(configuration, {
		cwd: "/baseline/project/subproject",
		model: { provider: "template", modelId: "model" },
		thinking: "medium",
		tools: ["agent_message", "agent_spawn"],
		skills: ["base-skill"],
		extensions: ["/extensions/base.ts"],
		projectContext: {
			mode: "replace",
			body: "Template context\n\nSpawn context",
		},
	});
});

test("fails when no configured Template model is available", () => {
	assert.throws(
		() => resolveAgentRunConfiguration({
			inherited: {
				cwd: "/project",
				model: { provider: "base", modelId: "model" },
				thinking: "low",
				tools: [],
				skills: [],
				extensions: [],
			},
			template: {
				name: "fallback-agent",
				models: [
					{ model: { provider: "missing-a", modelId: "model" }, thinking: "low" },
					{ model: { provider: "missing-b", modelId: "model" }, thinking: "high" },
				],
				projectContextMode: "append",
				projectContext: "",
				sourcePath: "/templates/fallback-agent.md",
			},
			fixedTools: [],
			isModelAvailable: () => false,
		}),
		/No configured Agent Template model is available: missing-a\/model, missing-b\/model/,
	);
});

test("paired spawn model override bypasses unavailable Template candidates", () => {
	const inherited = {
		cwd: "/project",
		model: { provider: "parent", modelId: "model" },
		thinking: "low" as const,
		tools: [],
		skills: [],
		extensions: [],
	};
	const template = {
		name: "fallback-agent",
		models: [{
			model: { provider: "missing", modelId: "model" },
			thinking: "high" as const,
		}],
		projectContextMode: "append" as const,
		projectContext: "",
		sourcePath: "/templates/fallback-agent.md",
	};
	const base = { inherited, template, fixedTools: [], isModelAvailable: () => false };

	assert.deepEqual(resolveAgentRunConfiguration({
		...base,
		overrides: {
			model: {
				id: "explicit/model",
				thinking: "inherit",
			},
		},
	}), {
		...inherited,
		model: { provider: "explicit", modelId: "model" },
		projectContext: { mode: "append", body: "" },
	});
	assert.deepEqual(resolveAgentRunConfiguration({
		...base,
		overrides: { model: { id: "inherit", thinking: "max" } },
	}), {
		...inherited,
		thinking: "max",
		projectContext: { mode: "append", body: "" },
	});
});

test("creates a public Template catalogue without Project Context bodies or source paths", () => {
	assert.deepEqual(createAgentTemplateCatalogue([
		{
			name: "research-agent",
			selectionGuide: "Use for research.",
			models: [{
				model: { provider: "research", modelId: "model" },
				thinking: "high",
			}],
			projectContextMode: "replace",
			projectContext: "Private child instructions.",
			sourcePath: "/private/research-agent.md",
		},
		{
			name: "moderator",
			selectionGuide: "Reserved for moderation.",
			projectContextMode: "append",
			projectContext: "Private moderator instructions.",
			sourcePath: "/private/moderator.md",
		},
		{
			name: "plain-agent",
			projectContextMode: "append",
			projectContext: "Private plain instructions.",
			sourcePath: "/private/plain-agent.md",
		},
	]), [{
		name: "plain-agent",
		projectContextMode: "append",
	}, {
		name: "research-agent",
		selectionGuide: "Use for research.",
		models: [{
			model: { provider: "research", modelId: "model" },
			thinking: "high",
		}],
		projectContextMode: "replace",
	}]);
});

test("catalogue hides unavailable candidates and Templates without one available candidate", () => {
	const catalogue = createAgentTemplateCatalogue([
		{
			name: "partly-available",
			models: [
				{ model: { provider: "missing", modelId: "model" }, thinking: "low" },
				{ model: { provider: "available", modelId: "model" }, thinking: "high" },
			],
			projectContextMode: "append",
			projectContext: "",
			sourcePath: "/templates/partly-available.md",
		},
		{
			name: "unavailable",
			models: [
				{ model: { provider: "missing", modelId: "other" }, thinking: "max" },
			],
			projectContextMode: "append",
			projectContext: "",
			sourcePath: "/templates/unavailable.md",
		},
	], ({ provider }) => provider === "available");

	assert.deepEqual(catalogue, [{
		name: "partly-available",
		models: [{
			model: { provider: "available", modelId: "model" },
			thinking: "high",
		}],
		projectContextMode: "append",
	}]);
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
