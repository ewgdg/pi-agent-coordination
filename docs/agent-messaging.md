# Agent messaging

Every authenticated ordinary Agent can send an immutable free-form Message to a known Agent in the same Workflow. Messages use fixed Deferred Delivery: they enter the recipient only after its current work settles.

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

The initial receipt reports live scheduling only:

| Delivery | Meaning | Next action |
| --- | --- | --- |
| `pending` | The volatile recipient lane admitted the Message. Delivery may still fail later. | Poll when proof matters. |
| `rejected` | This invocation was not admitted and cannot later deliver. | Correct the reported availability problem or retry later. |
| `indeterminate` | Admission may have happened, but confirmation was lost. | Poll before deciding whether to retry. |

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

Retry uses the original immutable Message and its fixed Deferred mode:

```json
{
  "operation": "retry",
  "messageId": "source-derived-message-id"
}
```

A retry returns existing Delivery proof when present. Otherwise it coalesces with the same Message already pending in the recipient lane or admits one new volatile item after authoritative absence. At most one recipient transcript Delivery can prove a Message.

If retry admission may have happened but its confirmation is lost, retry returns `indeterminate`; poll before deciding whether to retry again.

If recipient evidence cannot be inspected, retry is rejected without scheduling. This prevents a new delivery from being admitted while the coordinator cannot establish whether proof already exists.

## Delivery across dormant Runs

Agent identity outlives any individual Run. When a child has no work and no Run Retention Reason, its current Run is released and the Agent becomes dormant. A Deferred Message to that Agent starts a successor Run, delivers after the Run reaches its settled boundary, and releases the successor again when no retention reason remains.

Live scheduling is intentionally disposable. Run failure or Workflow shutdown discards every uncommitted item for that host. Receipts are not rewritten, Messages are not replayed automatically, and backlog is not transferred to a successor Run. Poll and explicit retry are the recovery path.

Malformed or contradictory transcript evidence is an invariant violation. Unknown Agents, cross-Workflow routes, and poll or retry by anyone other than the original sender are rejected before they can claim Delivery state.
