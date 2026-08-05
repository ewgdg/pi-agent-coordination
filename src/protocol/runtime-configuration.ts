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
