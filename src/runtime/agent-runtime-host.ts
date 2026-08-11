import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

import type { ModelVisibleMessageDelivery } from "../protocol/message-delivery.ts";
import type {
	ModelReference,
	RuntimeThinkingLevel,
} from "../protocol/runtime-configuration.ts";

export type EffectiveRuntimeSnapshot = Readonly<{
	cwd: string;
	model: ModelReference;
	thinking: RuntimeThinkingLevel;
	tools: readonly string[];
	skills: readonly string[];
	fileExtensionPaths: readonly string[];
	projectTrusted: boolean;
	sessionId: string;
}>;

export type AgentRuntimeWorkState = "active" | "settled" | "unavailable";
export type ToolBatchClassification = "blocking" | "asynchronous";

export type AgentRuntimeDelivery =
	| Readonly<{
		kind: "custom";
		message: ModelVisibleMessageDelivery;
		triggerTurn: true;
		deliverAs?: "steer" | "followUp";
	}>
	| Readonly<{
		kind: "user";
		content: string | readonly (TextContent | ImageContent)[];
		deliverAs?: "steer" | "followUp";
	}>;

export type TranscriptCommitConfirmation = Readonly<{
	inspectCommit(): boolean;
}>;

export type AgentRuntimeDeliveryDispatch = Readonly<{
	completion: Promise<void>;
	transcriptCommit?: Promise<boolean>;
}>;
