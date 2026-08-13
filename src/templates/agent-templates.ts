import type {
	ModelReference,
	RuntimeThinkingLevel,
} from "../protocol/runtime-configuration.ts";

export type ProjectContextMode = "append" | "replace";

export type AgentTemplate = Readonly<{
	name: string;
	model?: ModelReference;
	thinking?: RuntimeThinkingLevel;
	tools?: readonly string[];
	skills?: readonly string[];
	extensions?: "inherit" | "none";
	projectContextMode: ProjectContextMode;
	projectContext: string;
	sourcePath: string;
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
