# Serial incoming Agent Requests

## Goal

Make `agent_message` Answer the responder's sole active incoming Request without requiring `requestMessageId`, while preserving each Request's authored Deferred or Steer delivery mode.

## Intention

Move correlation and ordering knowledge out of the model-facing Answer interface and into coordination. Each responder receives at most one unresolved Request at a time. Later Requests stay in the existing bounded delivery scheduler and become eligible in admission order after the active Request resolves.

## Scope & Constraints

- Change Answer input to `{ operation: "answer", answer }`; do not retain the old shape.
- Keep `requestMessageId` as Request identity in receipts, deliveries, retries, cancellations, diagnostics, and Answer receipts.
- Keep `deliveryMode` on Request; default remains Deferred.
- Agent Spawn Creation Requests participate in the same incoming Request serialization.
- Only Request deliveries are gated. Ordinary Messages, Answers, Cancellations, and Supervisory Resume keep existing scheduling semantics.
- Answer commitment releases the active slot. Cancellation releases it only when Cancellation Delivery commits.
- Waiting Request scheduling remains volatile and bounded like existing pending deliveries; retry remains the recovery path after scheduling loss.
- Transcript evidence remains authoritative. Answer correlation must be recoverable from its canonical tool result or Delivery, because the Answer source call no longer contains the Request identity.

## Work Plan

1. Add failing protocol and coordination tests for the id-less Answer shape, sole-active correlation, no-active rejection, FIFO Request gating, authored delivery mode, cancellation promotion, and Creation Request participation.
2. Change Answer input schema, validation, equality, rendering, and prompt guidance.
3. Extend scheduled deliveries with Request-gating semantics so the scheduler admits all waiting Requests within existing capacity but selects at most the oldest eligible Request while continuing to deliver unrelated Messages.
4. Resolve a new Answer against the sole delivered unresolved Request and advance its responder scheduling after Answer commitment.
5. Rework canonical Answer evidence inspection so Request correlation comes from Answer receipts/Delivery rather than the source call arguments.
6. Update affected integration tests and documentation/domain glossary to the new interface and ordering invariant.
7. Run targeted tests, typecheck, then the full suite.

## Validation

- Targeted: protocol input/evidence, message tool schema/rendering, scheduler behavior, Agent Request integration, Creation Request/spawn integration, cold-host recovery.
- `npm run typecheck` (or the repository's equivalent script).
- Full `npm test` once targeted coverage passes.

## Progress

- [x] Design agreed: per-responder FIFO; only the front Request may deliver; preserve each Request's delivery mode; Answer omits correlation id.
- [x] Regression tests failed for the id-less Answer schema and queued Steer Cancellation behavior.
- [x] Protocol and scheduling implementation complete.
- [x] Documentation and glossary updated.
- [x] Targeted validation, Control/RPC schema coverage, and the complete fast suite pass.
- [x] Full process suite attempted and its unrelated failures recorded: stale `delivery` receipt assertions and PTY setup timeouts remain outside this change.

## Surprises & Discoveries

- Removing `requestMessageId` from the Answer source call moves durable correlation to the canonical Answer tool result or Answer Delivery/Retrieval. Correlation must be derived from that evidence before constructing a Request-specific Answer candidate; otherwise a Delivery-only Answer can be misapplied to another Request from the same requester. A result and Delivery naming different Requests remains an invariant violation, and a well-shaped result naming an unknown Request must fail rather than disappear as unrelated evidence.
- A queued Steer Request and its Steer Cancellation would otherwise freeze into the same batch in Request-first order. The scheduler now delivers the Cancellation alone, then suppresses the obsolete Request from proof.
- The admitted Answer/Cancellation maps are only pre-result bridges. The Answer handler must leave `answer_owed` intact; post-result safe-boundary reconciliation releases it and advances the queue. Exact Run failure, termination, and shutdown purge volatile authorship so a successor cannot mistake an unratified fact for canonical resolution. A later Answer Delivery can still ratify the Answer, clear a successor's restored obligation, and advance its waiting queue.
- The full process suite is broadly inconsistent with the current `messageStatus` receipt contract: `tests/message.test.ts` passes 4/25 because its shared helper still requires the removed `delivery: "pending"` field, many other process tests make the same stale assertion, and two PTY startup probes timed out. Feature-targeted process coverage for cold recovery and Owner clone behavior passes.

## Decisions

- The existing message delivery scheduler owns the waiting queue and its capacity/loss semantics; Request serialization is a delivery eligibility rule, not a second durable queue.
- A Request becomes active only when its Delivery commits.
- Zero active Requests is an input error; more than one is a protocol invariant violation.
- A Cancellation eligible in the same Steer freeze as its waiting Request is delivered first and alone so obsolete work never reaches the model in that batch.

## Outcomes & Retrospective

The model-facing Answer interface no longer carries Request identity. Each responder has one transcript-derived active Request, later ordinary and Creation Requests wait in the existing bounded scheduler, and Answer/Cancellation resolution promotes the next Request without changing its authored delivery mode.
