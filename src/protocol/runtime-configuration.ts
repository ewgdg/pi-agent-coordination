import { isAbsolute } from "node:path";

export const RUNTIME_THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export type RuntimeThinkingLevel = (typeof RUNTIME_THINKING_LEVELS)[number];

export type ModelReference = Readonly<{ provider: string; modelId: string }>;

export type RuntimeConfigurationBaseline = Readonly<{
	cwd: string;
	model: ModelReference;
	thinking: RuntimeThinkingLevel;
	tools: readonly string[];
	skills: readonly string[];
	extensions: readonly string[];
}>;

const RUNTIME_THINKING_LEVEL_SET = new Set<RuntimeThinkingLevel>(RUNTIME_THINKING_LEVELS);

export function isRuntimeThinkingLevel(value: unknown): value is RuntimeThinkingLevel {
	return typeof value === "string" && RUNTIME_THINKING_LEVEL_SET.has(
		value as RuntimeThinkingLevel,
	);
}

export function validateRuntimeConfigurationBaseline(
	value: unknown,
): RuntimeConfigurationBaseline {
	const baseline = requireExactRecord(value, [
		"cwd",
		"model",
		"thinking",
		"tools",
		"skills",
		"extensions",
	]);
	if (typeof baseline.cwd !== "string" || !isAbsolute(baseline.cwd)) {
		throw new Error("AgentConfiguration.baseline.cwd is invalid");
	}
	const model = requireExactRecord(baseline.model, ["provider", "modelId"]);
	if (!isIdentifier(model.provider) || !isIdentifier(model.modelId)) {
		throw new Error("AgentConfiguration.baseline.model is invalid");
	}
	if (!isRuntimeThinkingLevel(baseline.thinking)) {
		throw new Error("AgentConfiguration.baseline.thinking is invalid");
	}
	return {
		cwd: baseline.cwd,
		model: { provider: model.provider, modelId: model.modelId },
		thinking: baseline.thinking,
		tools: validateIdentifierList(baseline.tools, "tools"),
		skills: validateIdentifierList(baseline.skills, "skills"),
		extensions: validateIdentifierList(baseline.extensions, "extensions"),
	};
}

function validateIdentifierList(value: unknown, field: string): readonly string[] {
	if (!Array.isArray(value) || !value.every(isIdentifier)) {
		throw new Error(`AgentConfiguration.baseline.${field} is invalid`);
	}
	if (new Set(value).size !== value.length) {
		throw new Error(`AgentConfiguration.baseline.${field} contains duplicates`);
	}
	return [...value];
}

function requireExactRecord(
	value: unknown,
	expectedKeys: readonly string[],
): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("AgentConfiguration baseline must be an object");
	}
	const record = value as Record<string, unknown>;
	const actual = Object.keys(record).sort();
	const expected = [...expectedKeys].sort();
	if (
		actual.length !== expected.length ||
		actual.some((key, index) => key !== expected[index])
	) {
		throw new Error("AgentConfiguration baseline has an invalid shape");
	}
	return record;
}

function isIdentifier(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.includes("\0");
}
