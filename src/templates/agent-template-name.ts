const AGENT_TEMPLATE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function isAgentTemplateName(value: unknown): value is string {
	return typeof value === "string" && AGENT_TEMPLATE_NAME.test(value);
}
