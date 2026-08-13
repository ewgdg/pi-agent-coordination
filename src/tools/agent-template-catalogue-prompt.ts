import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type {
	AgentTemplateCatalogueEntry,
	AgentTemplatePromptContext,
} from "../templates/agent-templates.ts";

export function registerAgentTemplateCataloguePrompt(
	pi: ExtensionAPI,
	resolveTemplates: () => Promise<AgentTemplatePromptContext>,
): void {
	pi.on("before_agent_start", async (event) => {
		const catalogue = renderAgentTemplateCatalogue(await resolveTemplates());
		if (catalogue === undefined) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${catalogue}` };
	});
}

export function renderAgentTemplateCatalogue(
	context: AgentTemplatePromptContext,
): string {
	const templates = [...context.templates]
		.sort((left, right) => left.name.localeCompare(right.name))
		.map((template) => [
			`- name: ${template.name}`,
			...(template.selectionGuide === undefined
				? []
				: [`  selection-guide: ${JSON.stringify(template.selectionGuide)}`]),
			...(template.models === undefined
				? []
				: [
					"  models:",
					...template.models.flatMap(
						({ model, thinking }) => [
							`    - id: ${model.provider}/${model.modelId}`,
							`      thinking: ${thinking}`,
						],
					),
				]),
			...(template.tools === undefined ? [] : [`  tools: ${JSON.stringify(template.tools)}`]),
			...(template.skills === undefined ? [] : [`  skills: ${JSON.stringify(template.skills)}`]),
			...(template.extensions === undefined
				? []
				: [`  extensions: ${template.extensions}`]),
			`  project-context: ${template.projectContextMode}`,
		].join("\n"))
		.join("\n");
	return [
		"## Current Agent Runtime",
		`model:\n  id: ${context.currentRuntime.model.provider}/${context.currentRuntime.model.modelId}\n  thinking: ${context.currentRuntime.thinking}`,
		"## Available Agent Templates",
		"Use `agent_spawn.template` when a Template fits the task. A selection guide, when present, explains when to choose it. Its `config` fields override the listed Template configuration. In `config.model`, use `inherit` to inherit the current Agent's model or thinking value.",
		...(templates.length === 0 ? ["None."] : [templates]),
	].join("\n\n");
}
