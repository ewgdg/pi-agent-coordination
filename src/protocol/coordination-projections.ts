import type { TranscriptInspection } from "../transcript/agent-transcript.ts";
import { inspectMessageDeliveries } from "./message-delivery.ts";
import { inspectAnswerRetrievals } from "./message.ts";
import { answerResultSources, findAuthoredAgentMessageSources } from "./request-resolution.ts";

/** Install empty projections at the current bootstrap, before history catch-up. */
export function initializeCoordinationProjections(
	transcript: TranscriptInspection,
	agentId: string,
): void {
	findAuthoredAgentMessageSources({ authorAgentId: agentId, transcript });
	inspectMessageDeliveries({ recipientAgentId: agentId, transcript });
	inspectAnswerRetrievals({ requesterAgentId: agentId, transcript });
	answerResultSources({ authorAgentId: agentId, transcript });
}
