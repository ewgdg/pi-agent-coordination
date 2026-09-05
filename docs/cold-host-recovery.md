# Cold host recovery

Restarting the interactive host reconstructs the durable ordinary-Agent roster, structural authority, and standalone Moderators from Pi transcripts. It does not restore a previous runtime.

## Workflow transcript directory

Every ordinary child and Moderator session is stored in one Workflow-specific directory below the active Owner's native Pi session directory. The directory identity derives from the Owner's Agent ID, so all participants share it even when their first or later Runtime working directories differ. The resumed Owner continues using its native session file.

The Owner is validated before discovery. A cold admission enumerates the Workflow directory once and publishes a fresh in-memory projection only after candidate verification finishes. There is no registry file and no filesystem watcher.

## Candidate admission

A candidate must be one complete, current-version, LF-terminated UTF-8 Pi JSONL transcript. For an ordinary child, its native session header and current Identity must agree on Agent ID, Workflow, Direct Spawner, and the exact canonical `agent_spawn` pointer. A context-isolated child keeps that Identity as its root bootstrap. A Conversation Fork may contain historical Identities only before its unique matching current Identity; recovery verifies the exact completed parent prefix and the matching model-visible handoff. The spawn call must validate under the current input contract, its conversation mode and display metadata must match the transcript, and no other candidate may claim the same Agent ID or spawn source. The header cwd records the first Runtime's native session origin; it is not recovery configuration.

A Moderator candidate instead requires one strict model-visible Moderator Input as its first transcript entry, no ordinary Identity, fixed trigger-specific metadata, a matching session and Workflow relationship, bounded Request sources, normalized affected-Agent watermarks, and any valid previous-attempt pointer. It remains standalone and has no Direct Spawner.

Following Direct Spawner edges must reach the active Owner without a cycle. Direct children use the physical order of their canonical spawn calls, including multiple calls in one assistant entry; timestamps, filenames, scan order, and Agent IDs do not affect structural order.

Malformed, unreadable, incomplete, foreign, cyclic, duplicate, and source-conflicting candidates are quarantined with descendants whose authority depends on them. Independently verified subtrees remain available. Admission emits one bounded Owner warning and never repairs, rewrites, removes, or appends to candidate transcripts. Operations that name identifiable quarantined proof fail with `evidence_unavailable`; unrelated unknown identities remain `unknown_identity`.

## Dormant Agents and `/agents`

Recovered ordinary Agents and Moderators begin dormant. Observation and `/agents` do not resolve Runtime configuration, create Pi services, start a Run, invoke a model, or append transcript evidence. A later ordinary Message dynamically resolves the current ancestry, Template, explicit spawn configuration, resources, trust, native project context-file loading, and explicit system prompt before starting work through the participant's normal role-bound Run path. Native interaction becomes available after that session is live and retained.

The [Agent selector](agent-selector.md) presents Live rows in creation hierarchy and Dormant rows by Pi session recency. Dormant recency uses the latest user or assistant activity time, then the native session creation time. Unfiltered direct-child search remains in canonical spawn-call order regardless of presentation recency; filtered results use relevance first and that order as their deterministic tie-breaker.

## Residual Requests

Before every newly started Run proceeds, the host inspects complete physical current-scope evidence for that exact Agent. This includes evidence on abandoned branches and evidence summarized by later compaction.

- `awaiting_answer` is initialized for each canonical Request authored by the Agent that has neither a canonical requester Cancellation nor Answer Delivery.
- `answer_owed` is initialized for each canonical Request delivered to the Agent that has neither a canonical Answer commit nor Cancellation Delivery.

Creation Requests use the same predicates after verified child Identity makes them canonical. Durable Request Delivery, Answer, and Cancellation evidence may re-establish at most one active incoming Request for an Agent; multiple unresolved delivered Requests are an invariant violation. Recovered relationships are exact Request-keyed Run Retention Reasons; they are not a durable or Workflow-global obligation store.

Quarantining a peer does not erase relationships that the verified Agent's own transcript proves. Those local Retention Reasons return, while an operation that needs the quarantined peer's source transcript fails with `evidence_unavailable`.

Cold bootstrap reconstructs no per-responder Request queue, general delivery queue, Delivery Invocation, pending scheduling, previous Run, Run sequence, model turn, Operational Incident, Handling Key, Moderator attempt chain, exhausted Operational Attention, or automatic Message replay. Waiting Request order and every other uncommitted item remain lost. Transcript proof, polling, and explicit same-identity retry remain the recovery mechanisms.
