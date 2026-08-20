import type {
	ModelReference,
	RuntimeThinkingLevel,
} from "../protocol/runtime-configuration.ts";

export type SystemPromptMode = "append" | "replace";

export type AgentTemplateModelCandidate = Readonly<{
	model: ModelReference;
	thinking: RuntimeThinkingLevel;
}>;

export type AgentTemplate = Readonly<{
	name: string;
	useWhen?: string;
	models?: readonly AgentTemplateModelCandidate[];
	allowedTools?: readonly string[];
	skills?: readonly string[];
	extensions?: "inherit" | "none";
	systemPromptMode: SystemPromptMode;
	inheritProjectContext: boolean;
	systemPrompt: string;
	sourcePath: string;
}>;

/** Selection metadata safe to expose to a spawning Agent. */
export type AgentTemplateCatalogueEntry = Readonly<{
	name: string;
	useWhen?: string;
	models?: readonly AgentTemplateModelCandidate[];
	allowedTools?: readonly string[];
	skills?: readonly string[];
	extensions?: "inherit" | "none";
	systemPromptMode: SystemPromptMode;
	inheritProjectContext: boolean;
}>;

export type AgentTemplateCatalogueSnapshot = Readonly<{
	templates: readonly AgentTemplateCatalogueEntry[];
}>;

export type AgentTemplateRoot = Readonly<{
	scope: string;
	path: string;
}>;

export type AgentTemplateDiagnostic = Readonly<{
	scope: string;
	path: string;
	message: string;
	templateName?: string;
}>;

export type UnavailableAgentTemplate = Readonly<{
	reason: "invalid" | "ambiguous";
	scope: string;
	paths: readonly string[];
}>;

export type AgentTemplateDiscovery = Readonly<{
	templates: ReadonlyMap<string, AgentTemplate>;
	unavailable: ReadonlyMap<string, UnavailableAgentTemplate>;
	diagnostics: readonly AgentTemplateDiagnostic[];
}>;

export function selectAgentTemplateForRun(
	discovery: AgentTemplateDiscovery,
	selectedName: string,
): AgentTemplate | undefined {
	const unavailable = discovery.unavailable.get(selectedName);
	if (unavailable) {
		throw new Error(`Selected Agent Template ${selectedName} is ${unavailable.reason}`);
	}
	const template = discovery.templates.get(selectedName);
	if (template) return template;
	if (selectedName === "moderator") return undefined;
	throw new Error(`Selected Agent Template ${selectedName} is missing`);
}

export function createAgentTemplateCatalogue(
	templates: Iterable<AgentTemplate>,
	isModelAvailable: (model: ModelReference) => boolean = () => true,
): AgentTemplateCatalogueEntry[] {
	return [...templates]
		.filter(({ name }) => name !== "moderator")
		.sort((left, right) => left.name.localeCompare(right.name))
		.flatMap((template) => {
			const models = template.models?.filter(({ model }) => isModelAvailable(model));
			if (template.models !== undefined && models?.length === 0) return [];
			return [{
				name: template.name,
				...(template.useWhen === undefined
					? {}
					: { useWhen: template.useWhen }),
				...(models === undefined ? {} : { models }),
				...(template.allowedTools === undefined ? {} : { allowedTools: template.allowedTools }),
				...(template.skills === undefined ? {} : { skills: template.skills }),
				...(template.extensions === undefined ? {} : { extensions: template.extensions }),
				systemPromptMode: template.systemPromptMode,
				inheritProjectContext: template.inheritProjectContext,
			}];
		});
}
