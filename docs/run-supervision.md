# Run supervision

Workflow Owners, Direct Spawners, and Moderators can inspect and control authorized Agent Runs without changing Agent identity or the Workflow tree.

## Authority

The Workflow Owner may observe and control any verified non-Owner Agent. A Direct Spawner may observe and control only its immediate children. A Moderator may observe any known Workflow Agent and control any current non-Owner Run. An Agent may observe itself, but cannot control itself; a Moderator also cannot control the Owner Run. Knowing an Agent identity or exchanging Messages does not grant supervision authority.

`agent_observe` supports one status or direct-child query:

```json
{
  "operation": "status",
  "agentId": "child-agent-id"
}
```

```json
{
  "operation": "children"
}
```

Omitting `agentId` observes the caller. Direct children remain in canonical spawn order.

Each status contains the durable Agent identity and structural relationship, the current semantic Run state, and bounded primary evidence:

- `primaryEvidence.transcriptPath` is the authorized Pi transcript location, or `null` for a non-file-backed session.
- `primaryEvidence.inspectedThrough` identifies the last physical transcript entry included in the observation.
- `run.phase` is `starting`, `live`, `ending`, or `dormant`. A live Run also reports `work`, `attention`, and counted `retentionReasons`.

Retention categories are `owner_host_binding`, `pending_delivery`, `awaiting_answer`, `answer_owed`, `interactive_selection`, `interruption_hold`, and `moderator_handling`. Status never exposes Message payloads, prompts, history summaries, Run handles, or raw Pi objects.

## Generation failure and Automatic Reconciliation

Coordinated sessions issue one generic provider request per model generation. Process-local safety overrides disable Pi's regenerated-prompt outer retry, context-overflow auto-compaction retry, and provider retry budget without rewriting the user's Pi settings. OpenAI Codex sessions configured with `auto` transport use SSE so transport fallback cannot silently start another request.

Automatic Reconciliation requires a trusted provider or Agent Session adapter to return an exact same-generation handle, an admitted continuation recipe, and cumulative text-only output that preserves the already observed prefix. The runtime rejects tool-call content, a changed model or provider, regenerated output, stale generation proof, adapter failure, unavailable or exhausted continuation, and any indeterminate outcome. The adapter receives no callback capable of replaying the original prompt.

No generic provider can prove native stream resumption, so the built-in path does not invent it. Pi's confirmed length truncation with tool calls remains safe because Pi commits error tool results without invoking those tools and continues within the same Run. Every other unreconciled generation fault ends the exact Run normally; an unresolved Answer Obligation then uses ordinary Run Failure moderation rather than a separate reconciliation or Operation Review trigger.

## Interrupt an exact Run

```json
{
  "operation": "interrupt",
  "agentId": "child-agent-id"
}
```

Interruption resolves the target's exact current Run inside its serialized lane. It fences queued continuation, aborts active generation, waits for semantic settlement, and then establishes one exact `interruption_hold`. An active Human Request settles through its native error tool result before the Hold is reported.

The receipt disposition is:

- `held` when this invocation established the Hold.
- `already_held` when the exact current Run already has a Hold.
- `not_running` when no controllable current Run can be held.

While held, ordinary Messages, Requests, Answers, and Cancellations may remain admitted in the bounded recipient scheduler. They still consume ordinary capacity, but cannot commit Delivery, invoke the model, or clear the Hold. Native queued input cleared for safe interruption is retained for the exact Run and restored only after an explicit isolated resumption turn.

## Resume with explicit input

An authorized supervisor resumes through a model-visible Message:

```json
{
  "operation": "resume",
  "agentId": "child-agent-id",
  "content": "Continue, but verify the transcript watermark before acting."
}
```

Each held Agent has one reserved Supervisory Resume slot outside its ordinary Message capacity. The resume Delivery commits alone, clears only the exact Hold to which it was admitted, and receives one isolated model turn before the ordinary coordination backlog can proceed. The receipt returns the source-derived `messageId` and either `delivery: "pending"` or a rejection reason: `not_held`, `resume_slot_occupied`, or `target_unavailable`.

A resume that loses its bound Hold before Delivery becomes an ordinary Steer Message. It remains useful direction, but cannot clear a later Hold.

A supervisory dispatch failure reports an error, clears only the failed resumption attempt, and leaves the exact Hold available for an explicit retry.

The [Agent selector and view](agent-selector.md) present a durable Agent without changing protocol authority or Owner runtime ownership. An open live view adds `interactive_selection` retention to its exact Run and forwards input through that Run's complete Pi mode. Selecting a Dormant Agent starts one successor with that retention but submits no model input; its normal commands, shell input, custom extensions, and editor are then available through the attached live mode. Ordinary Message startup converges on the same serialized successor and attaches its mode before Delivery execution. Run failure replaces the attachment with a Dormant failure presentation without replaying work. Switching or closing removes live selection retention, and orderly shutdown closes the overlay before ending child Runs.

The native above-editor activity dock identifies the selected durable Agent by label, compact Agent identity, and semantic work status. It also projects only that Agent's direct children with a current Run; Dormant children remain absent from activity. Owner scope prepends Owner-only attention. The child mode's complete fullscreen transcript, Run state, widgets, editor, footer, commands, and extension UI render inside the headerless outer overlay, while the Owner presentation remains mounted and unchanged underneath.

## Terminate an exact Run

```json
{
  "operation": "terminate",
  "agentId": "child-agent-id"
}
```

Termination fences and confirms the end of the target's exact current Run, bypasses every Retention Reason, and discards its uncommitted coordination and native input. An Agent with an open live view rejects ordinary termination without changing its Run or overlay attachment:

```json
{
  "agentId": "child-agent-id",
  "disposition": "rejected",
  "rejectionReason": "interactive_selection"
}
```

After the view closes, ordinary termination may proceed. A successful or already-Dormant receipt reports `terminated` or `not_running` plus complete live `residualRequests.incoming` and `residualRequests.outgoing` counts. Coordinated shutdown remains a dedicated lifecycle path and closes any open Agent view before ending child Runs.

Termination does not roll back effects, Answer or cancel Requests, notify participants, mutate descendants, remove the Agent, or create Agent lifecycle evidence. Later Message Delivery may start a fresh successor Run for the same Agent identity. Recovery of any discarded Message remains explicit through transcript inspection, poll, or retry.

Interruption Holds, live scheduling, open Agent-view attachment, and exact Run handles are volatile. Pi transcripts remain the authority for durable identity, authored Messages, and committed Delivery.
