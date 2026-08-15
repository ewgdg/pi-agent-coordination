# Wait for selected Agent Answers

## Goal

Add a sequential `agent_wait` tool that parks the caller's exact Run until every selected outbound Agent Request has a canonical Answer, then returns the selected results together in request order.

## Intention

Give coordinating Agents an explicit join primitive without changing asynchronous Request delivery. Waiting blocks the model-facing tool call while releasing Workflow execution capacity. Transcript evidence remains authoritative; a pending Promise, Answer notifications, and periodic reconciliation are volatile live machinery only.

## Scope & Constraints

- `agent_wait` accepts one non-empty, duplicate-free `requestMessageIds` array.
- Every selected identity must be a canonical Agent Request authored by the caller in the current Workflow.
- The registered Pi tool uses sequential execution. Multiple emitted waits execute in Pi's ordinary sequential order; there is no public one-active-wait restriction.
- Results preserve input order.
- A canonical committed but requester-undelivered Answer returns `answer_delivered` with its immutable Answer body and source. The committed wait tool result becomes requester-side Answer Delivery proof.
- An Answer with existing requester-side Delivery proof returns `answer_already_delivered` with that proof and no duplicate body.
- Already committed Answers are found by the wait's initial reconciliation, including when a successor Run calls the tool.
- Unanswered Requests keep the Promise pending. Waiting explicitly releases the current Workflow execution permit without ending the exact Run or losing Request retention.
- Normal completion is event-driven from relevant Answer progress. One five-second recursive timeout per active wait reconciles canonical evidence as a fallback; it is not one timer per Request and does not automatically retry Request Delivery.
- Interruption, exact-Run fencing, termination, and shutdown settle and clean up the pending wait without consuming undelivered Answers.
- Transcript evidence, not a durable cache or Wait record, remains authoritative. Cold recovery does not reconstruct unfinished wait calls.
- Preserve existing explicit retry, cancellation, Request ordering, deadlock detection, and Operational Incident behavior.

## Confirmed Test Seams

The user agreed these public seams during design:

1. The registered sequential `agent_wait` tool schema and ordered native result.
2. Role-bound `WorkflowCoordinator` behavior backed by real Pi transcripts: immediate retrieval, pending wait completion, and prior Delivery proof.
3. Observable Workflow execution scheduling: a parked wait releases capacity so a responder can run.
4. Successor-Run retrieval from canonical Answer evidence without an explicit Request retry.
5. Exact-Run interruption/fencing cleanup and committed wait-result Delivery evidence.

Tests observe tool results, transcript evidence, and Run/scheduler behavior rather than private waiter maps or timers. Timer behavior uses an injected clock where direct fallback coverage is needed.

## Work Plan

1. Add one red tool-interface tracer for the `agent_wait` schema, sequential registration, and role availability; implement the public handler surface.
2. Add one red transcript-backed tracer for immediately retrieving one committed undelivered Answer; implement wait input/result protocol and canonical inspection.
3. Make committed `agent_wait` `answer_delivered` slots recognized as Answer Delivery proof, including ordered mixed delivered/already-delivered results.
4. Add a pending-wait tracer proving Answer commitment completes the Promise and the parked Run releases its Workflow execution permit; implement exact-Run suspension, notification, and completion lifecycle.
5. Add fallback reconciliation with one per-wait recursive five-second timeout, non-overlap, abort cleanup, and an injected test clock.
6. Add interruption/fencing, cancellation/race, successor-Run, and multi-Request ordering coverage at the agreed public seams.
7. Update domain language, Agent messaging documentation, tool guidance, and control/process schemas.
8. Run focused tests, typecheck, affected fast suites, diff hygiene, and only the smallest necessary process integration coverage.

## Validation

- Focused new `agent_wait` tests during red/green cycles.
- Existing Request resolution, Agent Request, Message tool, execution scheduler, lifecycle, Control schema, and extension conformance tests affected by the new surface.
- `npm run typecheck`.
- `npm run test:fast` when focused validation is green.
- Targeted process test only if in-memory seams cannot prove suspension across the process control adapter.
- `git diff --check`.

## Progress

- [x] Behavior, result distinctions, successor retrieval, polling cadence, and sequential-call semantics agreed.
- [x] Public test seams confirmed by the agreed interface and lifecycle contract.
- [x] Tool-interface tracer red then green.
- [x] Immediate Answer retrieval tracer red then green.
- [x] Wait-result Delivery proof implemented.
- [x] Pending Promise and scheduler suspension implemented.
- [x] Event notification and five-second fallback reconciliation implemented.
- [x] Exact result-commit fencing and prior-Delivery behavior covered.
- [x] Control/process wiring and parked Run status implemented.
- [x] Documentation updated.
- [x] Final review and validation closure.

## Decisions

- Polling is an event-loss fallback: immediate inspection plus event notification remain the primary paths.
- Use one timer per active wait call because it is the simplest correct implementation. Pi's sequential tool execution naturally prevents concurrent waits within one Agent Run.
- Do not add automatic Request retry. An undelivered Request and an undelivered committed Answer are different recovery cases.
- A proof-only result slot is used only for an Answer already delivered to the requester, not merely committed before the wait call.
- Parked waits report `agent_wait` attention and settled work while retaining their ordinary Request graph. Operation Review excludes the internal wait tool; Dependency Deadlock remains graph-driven.
- A resolved wait remains fenced until its native tool result commits. Only that committed result becomes Answer Delivery proof.

## Surprises & Discoveries

- Pi can resolve a tool Promise before its native result append. Keeping the waiter only until Promise resolution would let an exact-Run fence lose the race while still recording Answer Delivery proof. The coordinator therefore retains the candidate through the final `message_end` guard and transcript reconciliation.
- Event reconciliation can attempt requester execution reacquisition before the responder releases its own permit. The Workflow scheduler already queues this fairly; ending `agent_wait` attention before reacquisition preserves the capacity invariant.
- Request retry and aggregate wait results can share the existing Answer Retrieval evidence path once nested `answer_delivered` slots are validated as native requester-side Delivery proof.
- Durable aggregate proof must also resolve the canonical `agent_wait` source and verify that result Request identities exactly preserve the selected input order. Validating only nested Answer shapes would allow unrelated result slots to masquerade as Delivery evidence.

## Outcomes & Retrospective

`agent_wait` is available to every coordination role as a sequential explicit join. It validates caller-authored Requests, returns ordered `answer_delivered` and `answer_already_delivered` slots, parks the exact Run with visible Agent-Answer waiting status, releases Workflow execution capacity, and reacquires capacity before resolving its tool result.

Live Answer progress drives immediate reconciliation. One five-second recursive clock per active wait provides transcript-based fallback, including committed Answers whose return scheduling or notification was lost. New successor Runs can issue a fresh wait against the same durable Request identities; no unfinished Wait state is recovered and no Request is retried automatically.

The final native result is fenced against interruption, termination, Run failure, and shutdown. Only a canonical successful result whose Request identities match its committed wait input becomes requester-side Answer Delivery proof. Focused real-process tests cover capacity release, notification-free fallback, lost Answer retrieval, prior proof, and result-commit fencing.

Validation passed: TypeScript typecheck, complete fast suite, complete 19-test Agent Request suite, focused Request-resolution/Control/participant suites, and 14 targeted hosted/process Runtime tests. `git diff --check` is clean.
