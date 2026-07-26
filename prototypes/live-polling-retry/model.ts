// PROTOTYPE — throwaway decision artifact, not production protocol code.

export const PROTOTYPE_MESSAGE = {
  messageId: "message-001",
  workflowId: "workflow-owner",
  senderAgentId: "agent-sender",
  recipientAgentId: "agent-recipient",
  payload: "Please inspect the coordination boundary.",
} as const;

type RecipientRunState = "running" | "crashed";
type SchedulingOutcome = "admitted" | "failed";

export type SenderTranscriptEntry =
  | {
      type: "outbound-message";
      entryId: string;
      message: typeof PROTOTYPE_MESSAGE;
    }
  | {
      type: "message-retry";
      entryId: string;
      messageId: string;
    }
  | {
      type: "scheduling-outcome";
      sourceEntryId: string;
      messageId: string;
      outcome: SchedulingOutcome;
      reason?: string;
    };

export type RecipientTranscriptEntry = {
  type: "message-delivery";
  messageId: string;
  sourceSenderEntryId: string;
  senderAgentId: string;
  recipientAgentId: string;
  payload: string;
};

type PendingDelivery = {
  messageId: string;
  sourceSenderEntryId: string;
};

export type PollObservation =
  | { status: "not-polled" }
  | { status: "undelivered"; messageId: string }
  | {
      status: "delivered";
      messageId: string;
      sourceSenderEntryId: string;
      recipientAgentId: string;
    };

export type PrototypeState = {
  senderTranscript: SenderTranscriptEntry[];
  recipientTranscript: RecipientTranscriptEntry[];
  volatileScheduler: {
    recipientRun: RecipientRunState;
    pendingDeliveries: PendingDelivery[];
  };
  nextSenderEntryNumber: number;
  lastPoll: PollObservation;
  lastAction: string;
};

export type PrototypeAction =
  | { type: "send" }
  | { type: "deliver" }
  | { type: "crash-recipient" }
  | { type: "restart-recipient" }
  | { type: "poll" }
  | { type: "retry" }
  | { type: "reset" };

export const initialState = (): PrototypeState => ({
  senderTranscript: [],
  recipientTranscript: [],
  volatileScheduler: {
    recipientRun: "running",
    pendingDeliveries: [],
  },
  nextSenderEntryNumber: 1,
  lastPoll: { status: "not-polled" },
  lastAction: "Ready. Send the canonical message to begin.",
});

const senderEntryIdFor = (entryNumber: number): string =>
  `sender-entry-${String(entryNumber).padStart(3, "0")}`;

const findDelivery = (
  state: PrototypeState,
): RecipientTranscriptEntry | undefined =>
  state.recipientTranscript.find(
    (entry) => entry.messageId === PROTOTYPE_MESSAGE.messageId,
  );

const scheduleFromEntry = (
  state: PrototypeState,
  sourceEntryId: string,
): Pick<PrototypeState, "senderTranscript" | "volatileScheduler"> => {
  if (state.volatileScheduler.recipientRun === "crashed") {
    return {
      senderTranscript: [
        ...state.senderTranscript,
        {
          type: "scheduling-outcome",
          sourceEntryId,
          messageId: PROTOTYPE_MESSAGE.messageId,
          outcome: "failed",
          reason: "recipient Run was observably crashed before admission",
        },
      ],
      volatileScheduler: {
        ...state.volatileScheduler,
        pendingDeliveries: state.volatileScheduler.pendingDeliveries,
      },
    };
  }

  return {
    senderTranscript: [
      ...state.senderTranscript,
      {
        type: "scheduling-outcome",
        sourceEntryId,
        messageId: PROTOTYPE_MESSAGE.messageId,
        outcome: "admitted",
      },
    ],
    volatileScheduler: {
      ...state.volatileScheduler,
      pendingDeliveries: [
        ...state.volatileScheduler.pendingDeliveries,
        {
          messageId: PROTOTYPE_MESSAGE.messageId,
          sourceSenderEntryId: sourceEntryId,
        },
      ],
    },
  };
};

export const reducePrototype = (
  state: PrototypeState,
  action: PrototypeAction,
): PrototypeState => {
  switch (action.type) {
    case "send": {
      if (state.senderTranscript.some((entry) => entry.type === "outbound-message")) {
        return { ...state, lastAction: "Message already exists; use retry." };
      }

      const entryId = senderEntryIdFor(state.nextSenderEntryNumber);
      const withOutbound: PrototypeState = {
        ...state,
        senderTranscript: [
          {
            type: "outbound-message",
            entryId,
            message: PROTOTYPE_MESSAGE,
          },
        ],
        nextSenderEntryNumber: state.nextSenderEntryNumber + 1,
        lastPoll: { status: "not-polled" },
        lastAction: `Committed ${PROTOTYPE_MESSAGE.messageId} in ${entryId}.`,
      };

      const scheduled = scheduleFromEntry(withOutbound, entryId);
      return { ...withOutbound, ...scheduled };
    }

    case "deliver": {
      const [pending, ...remainingPendingDeliveries] =
        state.volatileScheduler.pendingDeliveries;
      if (!pending) {
        return { ...state, lastAction: "No volatile delivery is pending." };
      }
      if (state.volatileScheduler.recipientRun !== "running") {
        return { ...state, lastAction: "Recipient Run is not available." };
      }

      const existingDelivery = findDelivery(state);
      if (existingDelivery) {
        return {
          ...state,
          volatileScheduler: {
            ...state.volatileScheduler,
            pendingDeliveries: remainingPendingDeliveries,
          },
          lastAction: `Recipient suppressed duplicate delivery from ${pending.sourceSenderEntryId}; ${existingDelivery.sourceSenderEntryId} already committed ${pending.messageId}.`,
        };
      }

      return {
        ...state,
        recipientTranscript: [
          ...state.recipientTranscript,
          {
            type: "message-delivery",
            messageId: pending.messageId,
            sourceSenderEntryId: pending.sourceSenderEntryId,
            senderAgentId: PROTOTYPE_MESSAGE.senderAgentId,
            recipientAgentId: PROTOTYPE_MESSAGE.recipientAgentId,
            payload: PROTOTYPE_MESSAGE.payload,
          },
        ],
        volatileScheduler: {
          ...state.volatileScheduler,
          pendingDeliveries: remainingPendingDeliveries,
        },
        lastAction: `Recipient committed delivery sourced from ${pending.sourceSenderEntryId}.`,
      };
    }

    case "crash-recipient": {
      const pendingDeliveries = state.volatileScheduler.pendingDeliveries;
      const failedOutcomes: SenderTranscriptEntry[] = pendingDeliveries.map(
        (pending) => ({
          type: "scheduling-outcome",
          sourceEntryId: pending.sourceSenderEntryId,
          messageId: pending.messageId,
          outcome: "failed",
          reason: "recipient Run crashed before transcript delivery commit",
        }),
      );

      return {
        ...state,
        senderTranscript: [...state.senderTranscript, ...failedOutcomes],
        volatileScheduler: {
          recipientRun: "crashed",
          pendingDeliveries: [],
        },
        lastAction: pendingDeliveries.length
          ? `Crash rejected ${pendingDeliveries.length} volatile delivery invocation(s).`
          : "Recipient Run crashed with no pending delivery.",
      };
    }

    case "restart-recipient":
      return {
        ...state,
        volatileScheduler: {
          ...state.volatileScheduler,
          recipientRun: "running",
        },
        lastAction: "Recipient Run restarted; no delivery was replayed.",
      };

    case "poll": {
      const delivery = findDelivery(state);
      return {
        ...state,
        lastPoll: delivery
          ? {
              status: "delivered",
              messageId: delivery.messageId,
              sourceSenderEntryId: delivery.sourceSenderEntryId,
              recipientAgentId: delivery.recipientAgentId,
            }
          : {
              status: "undelivered",
              messageId: PROTOTYPE_MESSAGE.messageId,
            },
        lastAction: delivery
          ? "Sender found delivery proof in the recipient transcript."
          : "Sender found no recipient transcript delivery entry.",
      };
    }

    case "retry": {
      const outbound = state.senderTranscript.find(
        (entry) => entry.type === "outbound-message",
      );
      if (!outbound) {
        return { ...state, lastAction: "Send the message before retrying it." };
      }

      const entryId = senderEntryIdFor(state.nextSenderEntryNumber);
      const retryEntry: SenderTranscriptEntry = {
        type: "message-retry",
        entryId,
        messageId: PROTOTYPE_MESSAGE.messageId,
      };
      const withRetry: PrototypeState = {
        ...state,
        senderTranscript: [...state.senderTranscript, retryEntry],
        nextSenderEntryNumber: state.nextSenderEntryNumber + 1,
        lastAction: `Committed same-identity retry in ${entryId}.`,
      };

      const existingDelivery = findDelivery(withRetry);
      if (existingDelivery) {
        return {
          ...withRetry,
          lastPoll: {
            status: "delivered",
            messageId: existingDelivery.messageId,
            sourceSenderEntryId: existingDelivery.sourceSenderEntryId,
            recipientAgentId: existingDelivery.recipientAgentId,
          },
          lastAction: `Retry found existing recipient proof sourced from ${existingDelivery.sourceSenderEntryId}; nothing was rescheduled.`,
        };
      }

      const scheduled = scheduleFromEntry(withRetry, entryId);
      return { ...withRetry, ...scheduled };
    }

    case "reset":
      return initialState();
  }
};
