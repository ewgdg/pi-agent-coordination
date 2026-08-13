# Agent messaging and Requests

Every authenticated ordinary Agent can send an immutable free-form Message or correlated Request to a known Agent in the same Workflow. Each authored Message fixes either Deferred or Steer Delivery.

- Deferred waits until the recipient's current work settles and receives its own model turn.
- Steer waits for the current generation and its complete issued tool batch, then redirects the next model turn without aborting work or rolling back effects.

Omitting `deliveryMode` selects Deferred.

## Send a Message

Call `agent_message` with the recipient and content:

```json
{
  "operation": "send",
  "targetAgentId": "recipient-agent-id",
  "content": "Inspect the failing integration and report the smallest safe fix."
}
```

The committed tool call fixes the Message identity, sender, recipient, Workflow, and content. These values cannot be supplied again or changed by retry.

Use Steer only when the next model turn needs exceptional direction:

```json
{
  "operation": "send",
  "targetAgentId": "recipient-agent-id",
  "content": "Re-evaluate the fix against the newly discovered invariant.",
  "deliveryMode": "steer"
}
```

At a safe boundary, all Steer Messages already pending for that recipient are frozen in admission order, deduplicated against transcript proof, and committed as one model-visible batch. A Message admitted after that freeze waits for the next safe boundary. Steer takes precedence over Deferred when both are pending.

The initial receipt reports live scheduling only:

| Delivery | Meaning | Next action |
| --- | --- | --- |
| `pending` | The volatile recipient lane admitted the Message. Delivery may still fail later. | Poll when proof matters. |
| `rejected` | This invocation was not admitted and cannot later deliver. The reason distinguishes target availability, shutdown, and capacity exhaustion. | Correct the reported problem or retry later. |
| `indeterminate` | Admission may have happened, but confirmation was lost. | Poll before deciding whether to retry. |

The returned `messageId` is the source-derived protocol identity. A Request receipt also returns `requestId`; both fields contain that same identity.

## Request one Answer

Use a Request when the recipient owes one mechanically correlated Answer:

```json
{
  "operation": "request",
  "targetAgentId": "responder-agent-id",
  "question": "Which transcript entry proves the release handoff?"
}
```

The Request fixes its requester, responder, Workflow, question, Answer destination, and delivery mode. Request commitment retains the requester's current Run with `awaiting_answer`. Valid Delivery retains the responder with `answer_owed`.

Only the fixed responder may Answer, and only after valid Request Delivery:

```json
{
  "operation": "answer",
  "requestId": "source-derived-request-id",
  "answer": "The model-visible Answer Delivery entry proves the handoff."
}
```

The responder lane admits at most one canonical Answer across the complete current-scope transcript tree. Answer commitment ends that exact responder obligation even if return scheduling fails. Answers use fixed Steer scheduling so they become actionable at the next safe boundary without aborting generation or tools.

## Retrieve an Answer

Retrying a Request selects one authoritative outcome:

- `answer_already_delivered` returns existing requester-side Delivery proof.
- `answer_delivered` returns a committed undelivered Answer directly in the native retry result. That committed result is the Answer Delivery proof and preserves the responder's immutable authorship.
- `request_delivered` reports a delivered unanswered Request without redelivery.
- `request_pending` reschedules the same undelivered Request identity under its authored mode.
- `indeterminate` reports that Request readmission may have happened but confirmation was lost; poll before retrying again.

Incomplete or contradictory evidence schedules nothing. A later explicit retry is required when a concurrent Answer commits just after inspection.

## Cancel one Request

Only the requester may abandon its exact Request:

```json
{
  "operation": "cancel",
  "requestMessageId": "source-derived-request-id",
  "reason": "The result is no longer needed."
}
```

`requestMessageId` names the Request Message being withdrawn. A newly committed Cancellation receipt returns its own `messageId` and Delivery outcome. If the Request was already resolved, the receipt instead returns `already_cancelled` with `cancellationMessageId` or `already_answered` with `answerMessageId`; it does not repeat the Request identity from the call.

Cancellation commitment ends only that requester wait. Fixed-Steer Cancellation Delivery ends only that responder obligation and supplies actionable context; it does not abort tools, retract facts, undo effects, or terminate a Run. Cancellation delivered before a queued Request suppresses that Request without waking the responder for obsolete work.

Answer and Cancellation facts serialize independently in the requester and responder lanes. Either may commit while the other's Delivery is unavailable. Committed facts remain canonical, and a locally cancelled Request cannot be revived by retry or a late Answer.

Downstream cancellation is cooperative and one hop. A responder may cancel each Request it authored, but no cascade identity or subtree-success result exists.

## Check Delivery

Only the original sender can poll its Message:

```json
{
  "operation": "poll",
  "messageId": "source-derived-message-id"
}
```

| Disposition | Meaning | Evidence |
| --- | --- | --- |
| `delivered` | A valid model-visible Delivery exists in the recipient transcript. | `deliveryEvidence` points to that exact entry. |
| `not_observed` | A complete all-branch inspection found no Delivery at that observation point. | `inspectedThrough` identifies the physical append watermark. |
| `indeterminate` | Authoritative transcript inspection could not complete. | No absence or Delivery claim is made. |

Delivery proves that the Message became available to recipient session context. It does not prove that the model read it, acted on it, or produced a useful result.

## Retry an undelivered Message

Retry uses the original immutable Message and its authored delivery mode:

```json
{
  "operation": "retry",
  "messageId": "source-derived-message-id"
}
```

For an ordinary Message, retry returns existing Delivery proof when present. Otherwise it coalesces with the same Message already pending in the recipient lane or admits one new volatile item after authoritative absence. At most one recipient transcript Delivery can prove a Message.

Retry does not accept `deliveryMode`; it cannot turn Deferred into Steer or Steer into Deferred.

If retry admission may have happened but its confirmation is lost, retry returns `indeterminate`; poll before deciding whether to retry again.

If recipient evidence cannot be inspected, retry is rejected without scheduling. This prevents a new delivery from being admitted while the coordinator cannot establish whether proof already exists.

## Bounded scheduling

Each recipient admits at most the current Workflow Policy's `maxPendingDeliveriesPerAgent` distinct pending Message identities across Deferred and Steer; the default is 256. A retry of an already-pending identity consumes no additional capacity. Admitted work is never evicted, including when Owner reload lowers the limit.

When capacity is exhausted, the invocation returns `capacity_exhausted`. The canonical author Message remains in the sender transcript and can be retried explicitly after capacity becomes available; there is no hidden overflow or automatic retry.

An exact [Interruption Hold](run-supervision.md) blocks every ordinary Message, Request, Answer, and Cancellation from committing Delivery or invoking the recipient model. Held items remain admitted and consume ordinary capacity. One Supervisory Resume Message uses a separate reserved slot and cannot evict ordinary work.

See [Workflow Policy](workflow-policy.md) for strict file validation and prospective reload behavior.

## Delivery across dormant Runs

Agent identity and a selected Agent Runtime can outlive any individual Run. When a child has no work and no Run Retention Reason, its current Run is released and the Agent becomes dormant. A Message, Request, Answer, or Cancellation to that Agent activates a successor Run in its prepared Runtime when available, commits at the first boundary allowed by its authored mode, and releases the successor again when no Run Retention Reason remains.

Live scheduling is intentionally disposable. Run failure, exact Run termination, or Workflow shutdown discards every uncommitted item for that host. Receipts are not rewritten, Messages are not replayed automatically, and backlog is not transferred to a successor Run. Poll and explicit retry are the recovery path.

Malformed or contradictory transcript evidence is an invariant violation. Unknown Agents, cross-Workflow routes, and poll or retry by anyone other than the original sender are rejected before they can claim Delivery state.
