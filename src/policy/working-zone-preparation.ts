import type { RuntimeThinkingLevel } from "../protocol/runtime-configuration.ts";

export const CONTINUATION_WORK_SCALES = ["small", "medium", "large"] as const;
export type ContinuationWorkScale = (typeof CONTINUATION_WORK_SCALES)[number];

export const CONTEXT_DEPENDENCE_LEVELS = ["low", "medium", "high"] as const;
export type ContextDependence = (typeof CONTEXT_DEPENDENCE_LEVELS)[number];

export type ContextPreparation = Readonly<{
	workScale: ContinuationWorkScale;
	contextDependence: ContextDependence;
}>;

export const CONTEXT_DEPENDENCE_COST_TOKENS = Object.freeze({
	low: 95_000,
	medium: 127_000,
	high: 159_000,
} satisfies Record<ContextDependence, number>);

export const CONTINUATION_WORK_SCALE_RUNWAY_TOKENS = Object.freeze({
	small: 16_000,
	medium: 32_000,
	large: 64_000,
} satisfies Record<ContinuationWorkScale, number>);

export const THINKING_RUNWAY_MULTIPLIER = Object.freeze({
	off: 1,
	minimal: 1,
	low: 1,
	medium: 1.5,
	high: 2,
	xhigh: 2.5,
	max: 3,
} satisfies Record<RuntimeThinkingLevel, number>);

const RUNWAY_SHRINKAGE_WEIGHT = 0.3;
const RUNWAY_EXPANSION_WEIGHT = 0.15;

export function workingZonePreparationThreshold(options: ContextPreparation & Readonly<{
	thinking?: RuntimeThinkingLevel;
	contextWindow?: number;
	incomingRequestTokens?: number;
}>): number {
	const costThreshold = CONTEXT_DEPENDENCE_COST_TOKENS[options.contextDependence];
	if (
		options.thinking === undefined ||
		options.contextWindow === undefined ||
		options.incomingRequestTokens === undefined
	) return costThreshold;

	const desiredRunway = CONTINUATION_WORK_SCALE_RUNWAY_TOKENS[options.workScale] *
		THINKING_RUNWAY_MULTIPLIER[options.thinking];
	const runwayThreshold = Math.max(
		0,
		options.contextWindow - options.incomingRequestTokens - desiredRunway,
	);
	const runwayWeight = runwayThreshold < costThreshold
		? RUNWAY_SHRINKAGE_WEIGHT
		: RUNWAY_EXPANSION_WEIGHT;
	return (1 - runwayWeight) * costThreshold + runwayWeight * runwayThreshold;
}
