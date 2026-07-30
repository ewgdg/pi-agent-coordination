# Idle closure and Run restart serialization prototype

## Goal

Build a throwaway, in-process Pi `AgentSession` prototype that makes close/delivery ordering visible and tests whether one host-local serialization lane per Agent is sufficient for child Idle disposal, dormant restart, Request retry, and immediate dynamic spawn while retaining the Workflow Owner's pre-existing Run until host shutdown.

## Scope & Constraints

- Use real Pi `AgentSession`s with in-memory `SessionManager`s and a deterministic local model provider.
- Keep all coordination runtime state volatile; add no database, mailbox generation, acceptance event, replay, or recovery loop.
- Preserve stable Agent and Message identities in transcript evidence.
- Produce a one-command interactive terminal drive-through, not production code.
- Do not add tests; the artifact is a HITL logic prototype.

## Work Plan

1. Add a deterministic no-network Pi model runtime.
2. Implement a host with one serialized mutation lane per Agent and transcript-backed identity/message evidence.
3. Expose basic delivery, both close-race orderings, lost-Answer Request retry, and dynamic spawn/result scenarios in a small terminal UI.
4. Validate typechecking and scripted drive-throughs, then commit and publish the throwaway branch for human validation.

## Validation

- `npm run typecheck`
- `npm run prototype:idle-races -- --scenario all`
- Human terminal drive-through with `npm run prototype:idle-races`

## Progress

- [x] Reuse the accepted in-process SDK prototype branch as evidence and dependency baseline.
- [x] Implement the deterministic runtime and serialized host.
- [x] Implement the terminal driver and documentation.
- [x] Validate and publish the prototype for human drive-through.
- [ ] Record the HITL verdict and close the decision ticket.

## Surprises & Discoveries

- A target-local promise lane is enough to make the two child close/delivery outcomes explicit: close-first recreates the Run, while delivery-first commits on the current Run and leaves its later automatic close candidate stale.
- The Workflow Owner remains a normal Agent with one host-bound Run for the containing process lifetime. A compatibility adapter binds Pi's pre-existing interactive `AgentSession` as that Run; the adapter is not a domain entity. The Owner Run remains until explicit host shutdown instead of automatic Idle close.
- A Pi `SessionManager` can remain bound to a durable child Agent identity while successive in-process `AgentSession`s are disposed and recreated around it.
- Request retry needs no mailbox generation: direct transcript lookup can distinguish an already delivered Request, a committed Answer awaiting delivery, and a Request that needs same-identity rescheduling.

## Outcomes & Retrospective

The first HITL drive-through caught an incorrect automatic Idle close on the Workflow Owner. The corrected artifact retains the Owner's pre-existing Run and applies automatic Idle close only to child Runs. Strict typechecking, all 21 inherited tests, every scripted scenario, the explicit Owner-retention acceptance probe, and the pseudo-terminal smoke test pass again. The decision remains blocked only on the follow-up human drive-through.
