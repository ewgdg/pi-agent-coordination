# Agent messaging and Requests

Every authenticated ordinary Agent can send an immutable free-form Message or correlated Request to a known Agent in the same Workflow. Each authored Message fixes either Deferred or Steer Delivery.

- Deferred waits until the recipient's current work settles and receives its own model turn.
- Steer waits for the current generation and its complete issued tool batch, then redirects the next model turn without aborting work or rolling back effects.

Omitting `deliveryMode` selects Deferred.

## Select a recipient

For `send` and `request`, `targetAgent` accepts any of:

- an exact Agent label;
- a full Agent ID; or
- a unique suffix of an Agent ID.

```json
{
  "operation": "send",
  "targetAgent": "Researcher",
  "content": "Report the evidence you found."
}
```

```json
{
  "operation": "request",
  "targetAgent": "983c81e3",
  "question": "Which invariant should the fix preserve?"
}
```

Resolution follows one fixed order:

1. An exact full Agent ID resolves across the Workflow.
2. An Agent ID suffix resolves across the Workflow and must match exactly one Agent.
3. An exact label resolves within the caller's coordination neighborhood and must match exactly one addressable Agent.

An ordinary Agent's label neighborhood contains itself, its Direct Spawner, and its direct children. Owner and Moderator labels resolve across the whole Workflow. This keeps common local labels useful without weakening identity-based routing to other known Agents.

Selectors are exact and case-sensitive. Leading and trailing whitespace is ignored. Unknown and ambiguous selectors are rejected rather than resolved by roster order.

The initial author receipt includes the resolved full `targetAgentId`. Retry scheduling receipts repeat that canonical identity. The durable binding fixes the recipient for poll, retry, Run replacement, and cold recovery even if a later Agent creates the same label or suffix match.

## Send a Message

Call `agent_message` with the recipient and content:

```json
{
  "operation": "send",
  "targetAgent": "recipient-agent-id",
  "content": "Inspect the failing integration and report the smallest safe fix."
}
```

When the invocation authors a Message, its committed tool call fixes the Message identity, sender, recipient, Workflow, and content. These values cannot be supplied again or changed by retry.

An Agent with an active Answer Obligation cannot author an ordinary Message to that Request's requester. The invocation returns `disposition: "rejected"` with reason `answer_required` and the active `requestMessageId` without creating a Message identity or retry path. Keep provisional findings local and use `answer` for the curated result. If progress depends on requester input or a decision, issue a reverse `request`. Ordinary Messages to other Agents remain available. Existing Messages are not withdrawn when an Answer Obligation begins.

Use Steer only when the next model turn needs exceptional direction:

```json
{
  "operation": "send",
  "targetAgent": "recipient-agent-id",
  "content": "Re-evaluate the fix against the newly discovered invariant.",
  "deliveryMode": "steer"
}
```

At a safe boundary, all Steer Messages already pending for that recipient are frozen in admission order, deduplicated against transcript proof, and committed as one model-visible batch. A Message admitted after that freeze waits for the next safe boundary. Steer takes precedence over Deferred when both are pending.

The initial receipt reports live sending only:

| `messageStatus` | Meaning | Next action |
| --- | --- | --- |
| `sent` | The recipient lane admitted the Message for asynchronous Delivery. It may still be queued and is not necessarily delivered. | Poll only when Delivery proof matters. |
| `not_sent` | This invocation was not admitted. `reason` distinguishes target availability, shutdown, and capacity exhaustion. | Retry the same Message identity after correcting the problem. |
| `unknown` | Admission may have happened, but confirmation was lost. | Poll the same Message identity before retrying. |

An ordinary Message receipt returns its source-derived `messageId`. An Agent Request receipt instead returns `requestMessageId`, the Request Message's source-derived identity. Initial author receipts and later retry scheduling receipts also return the resolved full `targetAgentId`.

## Delivery presentation

The recipient transcript renders each delivered item as a readable message block. Its collapsed view shows the Message type, sender label with the final eight characters of the Agent identity, and the first ten terminal-width-aware rows of the body. A trailing ellipsis marks a truncated preview. Outgoing Message and Request tool calls use the same body preview, label, and compact identity format for the receiver. Expanding the block shows the sender label with the full Agent identity and the complete Message, Request question, Answer, or Cancellation reason with Markdown formatting. Batched Deliveries keep each item's sender and type visible instead of presenting the protocol JSON.

## Request one Answer

Use a Request when the recipient owes one mechanically correlated Answer:

```json
{
  "operation": "request",
  "targetAgent": "responder-agent-id",
  "question": "Which transcript entry proves the release handoff?"
}
```

The Request fixes its requester, responder, Workflow, question, Answer destination, and delivery mode. Request commitment retains the requester's current Run with `awaiting_answer`.

Requests targeting one responder wait in admission order. Only the front Request is eligible for its authored Deferred or Steer Delivery, and it cannot deliver while the responder has an unresolved Answer Obligation. Ordinary Messages, Answers, Cancellations, and Supervisory Resume are not blocked by this Request ordering. Valid Request Delivery creates the responder's sole `answer_owed` obligation.

The responder Answers that sole active Request without supplying correlation identity:

```json
{
  "operation": "answer",
  "answer": "The model-visible Answer Delivery entry proves the handoff."
}
```

Answer commitment correlates the immutable Answer to the active Request, ends that obligation even if return scheduling fails, and makes the next waiting Request eligible. Calling Answer without an active Request is rejected. More than one active Request is a protocol invariant violation. Answers use fixed Steer scheduling so they become actionable at the requester's next safe boundary without aborting generation or tools.

After Answer commitment, ordinary Message authorship to the former requester is available again. Request Cancellation restores it only when Cancellation Delivery ends the responder's obligation.

The Answer tool call is the responder's terminal response to that Request. The responder does not add an assistant-message recap or summary after it. Unless another obligation or independent task remains, the responder ends the turn immediately and leaves passive waiting or later continuation to the runtime.

## Agent delegation

An Agent Request can ask for existing information or a decision without delegating work. When `agent_message` operation `request` or `agent_spawn` delegates work, partition it into bounded, non-overlapping work units before sending the Request.

After Delivery admission, the responder owns the delegated work until its Answer arrives or the Request is cancelled. Continue only disjoint work that would remain necessary if the responder returned a complete, correct Answer. Otherwise end the turn. The runtime waits for turn-triggering input and resumes the existing continuation when it arrives. Duplicate investigation is appropriate only when the Request explicitly asks for an independent cross-check.

Reuse an existing Agent only when context acquired through its earlier work materially reduces rediscovery. Spawn a fresh Agent when that context is not relevant. A continuation Request may ask the idle recipient to prepare its existing context before Delivery:

```json
{
  "operation": "request",
  "targetAgent": "existing-agent-id",
  "question": "Continue the implementation using the constraints you already verified.",
  "contextPreparation": {
    "workScale": "medium",
    "contextDependence": "high"
  }
}
```

`workScale` estimates expected context growth as `small`, `medium`, or `large`. `contextDependence` estimates the value of exact prior context as `low`, `medium`, or `high`. Both fields are required inside `contextPreparation`. The committed Request owns these estimates; retry accepts only the Request identity and cannot replace them. The recipient sees the ordinary Request projection without preparation metadata.

Omit `contextPreparation` to retain ordinary Pi compaction behavior. When it is present, an idle child with automatic compaction enabled compares current context usage with the cost and runway threshold in [ADR 0003](adr/0003-continuation-working-zone-preparation.md). If preparation is warranted, the child calls the active public compaction strategy once before committing the Request. Pi summarization receives the prospective question only as relevance guidance and is told not to include, paraphrase, or claim receipt of the uncommitted Request. Extension-owned strategies may ignore that guidance and still provide the compaction result.

Unknown context usage and disabled automatic compaction skip the optional attempt. Active Steer Delivery keeps its exact queue order and skips proactive preparation. A below-native optional failure warns in the child and continues Delivery; failure at Pi's native threshold remains blocking. Cancellation or Runtime replacement during preparation fences the exact Delivery.

## Retrieve an Answer

Retrying a Request selects one authoritative outcome:

- `answer_already_delivered` returns existing requester-side Delivery proof.
- `answer_delivered` returns a committed undelivered Answer directly in the native retry result. That committed result is the Answer Delivery proof and preserves the responder's immutable authorship.
- `request_delivered` reports a delivered unanswered Request without redelivery.
- `messageStatus: "sent"` reports that the same undelivered Request was readmitted under its authored mode.
- `messageStatus: "unknown"` reports that Request readmission may have happened but confirmation was lost; poll before retrying again.

Incomplete or contradictory evidence schedules nothing. If direct Answer Delivery already owns a frozen or dispatched scheduling reservation but has not committed proof yet, retry reports `messageStatus: "unknown"` with `reason: "inspection_incomplete"` rather than competing with that Delivery. The native retry result is re-arbitrated immediately before commitment: a newly reserved direct Delivery changes a selected retrieval to that same indeterminate outcome, while newly committed direct proof changes it to `answer_already_delivered`. A later explicit retry is required after an indeterminate result.

## Join outstanding Answers

`agent_wait` is designed to join Answers. Prefer it only when one next decision requires every outstanding outbound Agent Request Answer together and avoiding one model turn per Answer matters:

```json
{}
```

If strict fan-in is unnecessary, let ordinary Answer Delivery reactivate the Agent. Do not poll merely to wait. Ordinary Messages do not satisfy Agent Requests.

When the committed sequential `agent_wait` call begins execution, it takes one fixed snapshot of every outstanding Request authored by the caller. The snapshot preserves canonical Request authoring order, includes unanswered Requests and committed Answers that lack requester-side Delivery proof, and excludes cancelled Requests and Answers already delivered to the requester. A Request authored after the Wait call is outside that snapshot, including a later Request in the same assistant tool batch. A call with no outstanding Requests is rejected.

Before reporting progress or parking, the call rejects if any unanswered Request in the snapshot targets a Dormant Agent. The error identifies each blocking Request and responder. Reactivate the same durable Agent through ordinary Message Delivery if its work remains needed, or cancel a Request you authored before replacing abandoned work or waiting again. A committed Answer remains retrievable through `agent_wait` even when its responder is Dormant.

The tool is sequential. After admission, it parks the exact caller Run until every Request in the snapshot has a canonical committed Answer. A child caller releases its child execution slot while parked; Owner and Moderator Runs consume no child slot at any time. The tool does not retry Request Delivery, cancel Requests, or create durable Wait state. Before waiting, resolve `not_sent` and `unknown` Request receipts through explicit retry or polling when Delivery proof matters.

While the join is parked, its tool row lists the responder Agents in the fixed snapshot. When the join completes, the row replaces that progress with Answer Delivery blocks in snapshot order: each `[Answer] from …` header is followed by the Answer body using the same collapsed preview and expanded Markdown presentation as direct Answer Delivery. Expanding the Wait also shows its protocol details.

Results preserve snapshot order. A committed Answer not previously delivered to the requester returns `answer_delivered` with the immutable Answer and its source; the committed `agent_wait` tool result becomes that Answer's requester-side Delivery proof. An Answer with existing requester-side Delivery proof instead returns `answer_already_delivered` with the prior proof and does not duplicate the body. If direct Answer Delivery already owns its frozen or dispatched scheduling reservation, the Wait remains parked until that Delivery commits and then returns proof-only. Pi re-arbitrates the aggregate at its native result-commit edge, replacing stale Answer bodies with proof-only slots when direct Delivery won meanwhile.

The wait registers before its final evidence inspection, responds to live Answer progress, and reconciles canonical transcript evidence every five seconds as an event-loss fallback. A successor Run may call `agent_wait` to snapshot and retrieve its still-outstanding Answers. Unfinished Wait calls and their timers are volatile and are not reconstructed after host loss.

Primary interactive human input directed at the waiting Agent preempts the parked Wait and continues through Pi's native steering path. The next model generation receives the non-error `{ "disposition": "preempted" }` result and the user message. Explicit follow-up input remains queued until later.

An eligible inbound Agent Request also preempts the parked Wait so the recipient can answer or otherwise act on that Request. The Request may come from any Agent. Its Delivery is reserved and committed before the next model generation. At either preemption boundary, the complete Answer aggregate wins if it is already ready. Otherwise the Wait returns `{ "disposition": "preempted" }`, consumes no Answer, and creates no requester-side Answer Delivery proof. Follow the new human direction or handle the inbound Request first. Call `agent_wait` again only if one decision still requires every then-outstanding Answer; the new call takes a fresh snapshot. Ordinary Deferred and Steer Agent Messages remain queued.

Interruption, exact-Run fencing, termination, or shutdown ends the live wait without consuming undelivered Answers. A successful aggregate result becomes Delivery proof only when its native tool result commits. Ordinary Answer Delivery or explicit Request retry therefore remains available if result commitment loses a race.

### Fan-out and strict fan-in

An Agent may send two Requests, continue disjoint inspection outside both requested work units, and join only when its next decision needs both Answers:

```json
{ "operation": "request", "targetAgent": "design-agent", "question": "Which invariant should the interface preserve?" }
```

```json
{ "operation": "request", "targetAgent": "test-agent", "question": "Which observable regression must the test cover?" }
```

After completing that disjoint work, call `agent_wait` with `{}` if the implementation decision requires both outstanding Answers. If either Answer can be handled independently, settle instead and let each Answer activate an ordinary model turn.

### Interactive reverse Request

Suppose the requester calls `agent_wait`, but the responder needs a decision before it can produce its curated Answer. The responder keeps provisional findings local and authors a reverse Request instead of sending an ordinary Message:

```json
{ "operation": "request", "targetAgent": "original-requester", "question": "Should the interface fail or skip unavailable evidence?" }
```

The reverse Request preempts the original requester's Wait. The original requester handles its new Answer obligation with `agent_message` operation `answer`, then calls `agent_wait` again only if its next decision still needs every outstanding Answer. The fresh Wait includes the unresolved original Request; the preempted Wait consumed no Answer Delivery.

## Cancel one Request

Only the requester may abandon its exact Request:

```json
{
  "operation": "cancel",
  "requestMessageId": "source-derived-request-id",
  "reason": "The result is no longer needed."
}
```

`requestMessageId` names the Request Message being withdrawn. A newly committed Cancellation receipt returns its own `messageId`, canonical `targetAgentId`, and Delivery outcome. If the Request was already resolved, the receipt instead returns `already_cancelled` with `cancellationMessageId` or `already_answered` with `answerMessageId`; it does not repeat the Request identity from the call.

Cancellation commitment ends only that requester wait. Fixed-Steer Cancellation Delivery ends only that responder obligation, makes the next waiting Request eligible, and supplies actionable context; it does not abort tools, retract facts, undo effects, or terminate a Run. Cancellation delivered before a waiting Request suppresses that Request without waking the responder for obsolete work.

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

If retry admission may have happened but its confirmation is lost, retry returns `messageStatus: "unknown"`; poll before deciding whether to retry again.

If recipient evidence cannot be inspected, retry is rejected without scheduling. This prevents a new delivery from being admitted while the coordinator cannot establish whether proof already exists.

## Bounded scheduling

Each recipient admits at most the current Workflow Policy's `maxPendingDeliveriesPerAgent` distinct pending Message identities across Deferred and Steer; the default is 256. A retry of an already-pending identity consumes no additional capacity. Admitted work is never evicted, including when Owner reload lowers the limit.

Waiting Requests consume this same pending Delivery capacity. A Request receipt with `messageStatus: "sent"` means the recipient lane admitted it; the Request may still be waiting behind the responder's active Request before ordinary Deferred or Steer scheduling applies.

When capacity is exhausted, the invocation returns `messageStatus: "not_sent"` with reason `capacity_exhausted`. The canonical author Message remains in the sender transcript and can be retried explicitly after capacity becomes available; there is no hidden overflow or automatic retry.

An exact [Interruption Hold](run-supervision.md) blocks every ordinary Message, Request, Answer, and Cancellation from committing Delivery or invoking the recipient model. Held items remain admitted and consume ordinary capacity. One Supervisory Resume Message uses a separate reserved slot and cannot evict ordinary work.

See [Workflow Policy](workflow-policy.md) for strict file validation and prospective reload behavior.

## Delivery across dormant Runs

Agent identity and a selected Agent Runtime can outlive any individual Run. When a child has no work and no Run Retention Reason, its current Run is released and the Agent becomes dormant. A Message, Request, Answer, or Cancellation to that Agent activates a successor Run in its prepared Runtime when available, commits at the first boundary allowed by its authored mode, and releases the successor again when no Run Retention Reason remains.

Before an idle model-starting custom Delivery commits, the child Turn Compaction Gateway recomputes Pi's current native threshold. A continuation Request with `contextPreparation` also applies its working-zone threshold. The gateway calls the active public strategy at most once for that exact admission, preserves the exact custom message, and completes preparation before Delivery transcript commitment. A custom Delivery that does not trigger a model turn commits without compaction or interruption. Active Steer and Follow-up Delivery uses Pi's raw queue; when work is queued after `agent_end`, Pi's native threshold compaction proceeds before the continuation.

Live scheduling, including the per-responder waiting Request order, is intentionally disposable. Run failure, exact Run termination, or Workflow shutdown discards every uncommitted item for that host. A successor reconstructs only the one active Request proved by durable Delivery and resolution evidence; it does not reconstruct waiting queue order. Receipts are not rewritten, Messages are not replayed automatically, and backlog is not transferred to a successor Run. Poll and explicit same-identity retry are the recovery path.

Malformed or contradictory transcript evidence is an invariant violation. Unknown Agents, cross-Workflow routes, and poll or retry by anyone other than the original sender are rejected before they can claim Delivery state.
