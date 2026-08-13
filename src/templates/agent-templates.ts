import type {
	ModelReference,
	RuntimeThinkingLevel,
} from "../protocol/runtime-configuration.ts";

export type ProjectContextMode = "append" | "replace";

export type AgentTemplate = Readonly<{
	name: string;
	selectionGuide?: string;
	model?: ModelReference;
	thinking?: RuntimeThinkingLevel;
	tools?: readonly string[];
	skills?: readonly string[];
	extensions?: "inherit" | "none";
	projectContextMode: ProjectContextMode;
	projectContext: string;
	sourcePath: string;
}>;

/** Selection metadata safe to expose to a spawning Agent. */
export type AgentTemplateCatalogueEntry = Readonly<{
	name: string;
	selectionGuide?: string;
	model?: ModelReference;
	thinking?: RuntimeThinkingLevel;
	tools?: readonly string[];
	skills?: readonly string[];
	extensions?: "inherit" | "none";
	projectContextMode: ProjectContextMode;
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
): AgentTemplateCatalogueEntry[] {
	return [...templates]
		.filter(({ name }) => name !== "moderator")
		.sort((left, right) => left.name.localeCompare(right.name))
		.map((template) => ({
			name: template.name,
			...(template.selectionGuide === undefined
				? {}
				: { selectionGuide: template.selectionGuide }),
			...(template.model === undefined ? {} : { model: template.model }),
			...(template.thinking === undefined ? {} : { thinking: template.thinking }),
			...(template.tools === undefined ? {} : { tools: template.tools }),
			...(template.skills === undefined ? {} : { skills: template.skills }),
			...(template.extensions === undefined ? {} : { extensions: template.extensions }),
			projectContextMode: template.projectContextMode,
		}));
}
