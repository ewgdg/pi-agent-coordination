# Obligation Stall moderation

The host starts one isolated Moderator when a live ordinary Agent settles while it still owes an Answer and has no credible way to make progress.

## Detection

An Agent has an Obligation Stall only while all of these conditions hold:

- its current Run is live and settled;
- at least one exact `answer_owed` Request relationship remains;
- no model work, pending Delivery, Human Request, interactive selection, or Interruption Hold can advance the Run;
- no outgoing Request reaches another starting, active, input-admitted, or recursively progressing ordinary Agent.

A dormant outgoing responder is not progress. A closed Request cycle is not progress either.

The host derives a transient Handling Key from the affected Agent and the sorted qualifying Request identities. The key suppresses duplicate Moderators only while that exact continuous predicate remains true. Any relevant Run, input, Delivery, Hold, or Request transition revalidates the Workflow. When the predicate clears, the key and `moderator_handling` retention are released immediately without aborting Moderator work or settling its ordinary Requests.

## Atomic Moderator bootstrap

Before starting a Moderator Run, the host commits one visible `agent-coordination.moderator-input` as the first transcript entry. It contains:

- the fresh Agent and Workflow relationship;
- fixed `moderator` metadata and the Owner-derived runtime baseline;
- the `obligation_stall` trigger and affected Agent;
- the total qualifying obligations and up to 16 exact Request sources;
- the affected Agent's inspection watermark.

Failure before this commit creates no Agent. Failure after it leaves a valid dormant Moderator that remains available for routing and post-mortem inspection.

A Moderator is a standalone Workflow Agent with no Direct Spawner. Its fixed tools are `agent_message`, `agent_observe`, `agent_control`, `ask_user_question`, and `moderator_control`; it never receives `agent_spawn`.

## Diagnosis, escalation, and control

A Moderator can pull status for any known Workflow Agent and enumerate ordinary children. It can interrupt, resume, or terminate any current non-Owner Run, but cannot control the Owner or itself. Every observation, Message, Request, Human Request, and control operation remains authenticated as the Moderator's own Agent identity.

Questions of task intent, priority, value, policy, risk, irreversible effects, or Owner action use an ordinary Agent Request to the Workflow Owner. That Request keeps the normal Answer obligation, retention, Delivery, and retrieval semantics.

## Resolution

`moderator_control` records the Moderator's summary and rationale in its ordinary tool call. Resolution is blocked while the Moderator has an incoming or outgoing Request relationship, or while the original Stall still holds.

Once those blockers clear, the receipt is:

- `resolved` when a progress source now protects an original qualifying obligation;
- `already_cleared` when the original qualifying obligations no longer remain.

Resolution creates no Incident record or lifecycle state. Moderator Input and the ordinary action transcripts remain the durable evidence.

## Cold recovery

Cold discovery strictly validates Moderator Input, admits valid Moderators as standalone dormant Agents, and quarantines malformed candidates. Recovered Moderators appear in `/agents`, accept normal routing, and restart with the Moderator toolset.

Recovery does not reconstruct a Stall, Handling Key, previous Run, scheduling, or Moderator reuse. A newly observed live Stall always receives a fresh Moderator.
