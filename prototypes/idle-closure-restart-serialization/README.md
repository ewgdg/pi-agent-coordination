# Idle closure and Run restart serialization prototype

> **PROTOTYPE — throw this code away after the decision.**

## Question

Can one in-process host serialize all mutation of each Pi-session Agent strongly enough that an unblocked Idle child `AgentSession` can be disposed while a racing inbound Message is either committed to that Run or starts a successor Run—without SQLite, mailbox generations, or a durable acceptance event? The Workflow Owner's pre-existing Run must remain live until host shutdown. The same mechanism must also support same-identity Request retry and immediate dynamic child creation.

## Run

```sh
npm run prototype:idle-races
```

The terminal frame shows every Agent's stable Pi session identity, current Run incarnation, Request blockers, transcript evidence counts, Messages, and the latest serialized operations. Use:

- `m` — send a Message to a dormant Agent; delivery starts a Run and unblocked Idle closes it.
- `c` — queue close before delivery; close disposes the old Run and delivery starts a successor.
- `d` — queue delivery before close; delivery commits to the old Run and the stale close cannot affect a successor.
- `r` — deliver a Request, retry it before an Answer exists, drop volatile Answer scheduling, then retry again to retrieve the responder's committed Answer.
- `s` — create a child Agent dynamically, commit its identity with the direct-Spawner relationship, start it immediately, and deliver initial work without approval state.
- `a` — commit and deliver the dynamically spawned child's Answer.

For an AFK text drive-through:

```sh
npm run prototype:idle-races -- --scenario all
```

## What is real

- Every Run is a real Pi `AgentSession` using Pi `0.82.1`.
- The Workflow Owner has one host-bound Agent Run for the containing Pi process lifetime. It has no automatic Idle close; only explicit host shutdown disposes it.
- A compatibility adapter binds Pi's pre-existing interactive `AgentSession` as that Owner Run. The adapter is implementation plumbing, not a separate domain entity or runtime species.
- Each Agent owns one stable in-memory `SessionManager`; disposing and recreating a child Agent's `AgentSession` preserves the Pi session ID and transcript.
- Pi's actual `sendCustomMessage(..., { triggerTurn: true })`, transcript commits, `agent_settled`, `isIdle`, and `dispose()` boundaries are exercised.
- The model provider is deterministic, local, and no-network so the race result depends on host scheduling rather than model latency or credentials.
- Agent Identity, Outbound Message, Message Retry, and Message Delivery are the only protocol evidence. There is no durable acceptance record.

## State model under test

Each Agent—including the Workflow Owner—has an Agent Run and one host-local promise lane. Run start, recipient delivery commit, duplicate check, and disposal all enter that lane. For child Agents, automatic Idle close enters the same lane and its close candidate is bound to one Run incarnation. The Owner's compatibility binding changes only admission and retention: its host-bound Run remains until explicit host shutdown.

- **delivery ordered first:** it sees the live Run and commits there;
- **close ordered first:** it disposes that Run, then delivery sees a dormant Agent and starts a successor;
- **stale close candidate:** it names the old incarnation and cannot close the successor.

Request blocking is derived through direct stable-identity transcript lookup. An outbound Request keeps its requester Run open until the correlated Answer is delivered. An inbound Request keeps its responder Run open until the Answer is committed. Retry preserves the Request identity: if no Answer exists it reschedules the same Request and recipient deduplication suppresses it; if an Answer already exists in the responder transcript it delivers that Answer.

Dynamic spawn intentionally has no cross-session atomicity claim. The parent commits the creation Request, the child commits its Agent Identity referencing that Request, the host registers and starts the child, and initial delivery follows as separately visible steps.

## Limits

This is decision evidence, not an implementation base. It does not test Human Requests, process crashes, transcript power-loss durability, multi-process writers, automated resend, offline delivery, supervision policy, or production package ergonomics. It keeps Pi transcripts in memory because persistence is not the question.
