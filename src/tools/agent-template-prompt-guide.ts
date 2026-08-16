import type {
	AgentTemplateCatalogueSnapshot,
} from "../templates/agent-templates.ts";

export function renderAgentTemplatePromptGuide(
	snapshot: AgentTemplateCatalogueSnapshot,
): string {
	const templates = [...snapshot.templates]
		.sort((left, right) => left.name.localeCompare(right.name))
		.map((template) => [
			`- name: ${template.name}`,
			...(template.useWhen === undefined
				? []
				: [`  use-when: ${JSON.stringify(template.useWhen)}`]),
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
			...(template.allowedTools === undefined
				? []
				: [`  allowed-tools: ${JSON.stringify(template.allowedTools)}`]),
			...(template.skills === undefined ? [] : [`  skills: ${JSON.stringify(template.skills)}`]),
			...(template.extensions === undefined
				? []
				: [`  extensions: ${template.extensions}`]),
			`  project-context: ${template.projectContextMode}`,
		].join("\n"))
		.join("\n");
	return [
		"## Current Agent Runtime",
		`model:\n  id: ${snapshot.currentRuntime.model.provider}/${snapshot.currentRuntime.model.modelId}\n  thinking: ${snapshot.currentRuntime.thinking}`,
		"## Available Agent Templates",
		"Use `agent_spawn.template` when a Template fits the task. `use-when`, when present, explains when to choose it. Its `config` fields override the listed Template configuration. In `config.model`, use `inherit` to inherit the current Agent's model or thinking value.",
		...(templates.length === 0 ? ["None."] : [templates]),
	].join("\n\n");
}
