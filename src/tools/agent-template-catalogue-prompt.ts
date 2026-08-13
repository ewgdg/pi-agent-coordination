import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { AgentTemplateCatalogueEntry } from "../templates/agent-templates.ts";

export function registerAgentTemplateCataloguePrompt(
	pi: ExtensionAPI,
	resolveTemplates: () => Promise<readonly AgentTemplateCatalogueEntry[]>,
): void {
	pi.on("before_agent_start", async (event) => {
		const catalogue = renderAgentTemplateCatalogue(await resolveTemplates());
		if (catalogue === undefined) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${catalogue}` };
	});
}

export function renderAgentTemplateCatalogue(
	agentTemplates: readonly AgentTemplateCatalogueEntry[],
): string | undefined {
	if (agentTemplates.length === 0) return undefined;
	const templates = [...agentTemplates]
		.sort((left, right) => left.name.localeCompare(right.name))
		.map((template) => [
			`- name: ${template.name}`,
			...(template.selectionGuide === undefined
				? []
				: [`  selection-guide: ${JSON.stringify(template.selectionGuide)}`]),
			...(template.model === undefined
				? []
				: [`  model: ${template.model.provider}/${template.model.modelId}`]),
			...(template.thinking === undefined ? [] : [`  thinking: ${template.thinking}`]),
			...(template.tools === undefined ? [] : [`  tools: ${JSON.stringify(template.tools)}`]),
			...(template.skills === undefined ? [] : [`  skills: ${JSON.stringify(template.skills)}`]),
			...(template.extensions === undefined
				? []
				: [`  extensions: ${template.extensions}`]),
			`  project-context: ${template.projectContextMode}`,
		].join("\n"))
		.join("\n");
	return [
		"## Available Agent Templates",
		"Use `agent_spawn.template` when a Template fits the task. A selection guide, when present, explains when to choose it. Its `config` fields override the listed Template configuration.",
		templates,
	].join("\n\n");
}
