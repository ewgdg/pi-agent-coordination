# Make Answer Delivery and retrieval exactly once

## Goal

Guarantee one requester-side Delivery proof when ordinary Answer Delivery races with `agent_wait` or Request retry, including stale scheduler continuations and host-dispatched work.

## Intention

Bind every delayed dispatch continuation to the exact Delivery it selected. Treat scheduler-held Delivery as retrievable, but once a Delivery has been handed to the runtime, make retrieval wait for that direct Delivery rather than creating a competing proof.

## Scope & Constraints

- Preserve duplicate-Delivery invariant checks.
- Keep the existing `WorkflowCoordinator` integration seam for tests.
- Do not clear unrelated Pi runtime queue input.
- Preserve fixed-Steer Answer scheduling and existing receipt shapes.
- Add the missing queued Request-retry regression.

## Work Plan

1. Add a failing Request-retry regression where retrieval commits while direct Answer dispatch is held.
2. Bind delayed dispatch callbacks to the captured Delivery and add a failing multi-Answer regression for stale callbacks.
3. Add explicit scheduler dispatch-state inspection and prevent Answer Retrieval from competing after direct Delivery has been handed to the runtime; cover the direct-dispatch-first ordering at the coordinator seam.
4. Run the focused integration suite, typecheck, diff checks, and a final review.

## Validation

- `node --test --test-concurrency=1 --test-reporter=spec tests/agent-request.test.ts`
- `npm run typecheck`
- `git diff --check`

## Progress

- [x] Confirmed the public integration seam.
- [x] Retry retrieval race.
- [x] Exact delayed dispatch identity.
- [x] Host-dispatched Delivery ownership.
- [x] Final validation.

## Decisions

- Retrieval wins only while direct Delivery remains scheduler-held. A frozen or dispatched direct Delivery owns completion and retrieval must not emit the Answer body.
- Re-arbitrate selected retry and Agent Wait results at Pi's native result-commit edge. A direct reservation yields an indeterminate retry result; committed direct proof yields proof-only retrieval output.
- Freeze exact Steer batches and give boundary tests an exact release continuation. Delayed continuations revalidate transcript proof and the entire selected dispatch set before bypassing the hook.

## Surprises & Discoveries

- Revalidating only inside the resumed drain was insufficient because proof removal happened after the stale continuation had already chosen to bypass the dispatch hook.
- Tool execution can select retrieval before direct Delivery wins. Exactly-once behavior therefore needs result-commit arbitration in addition to queue retirement.
- Interruption serializes queue capture in the same Agent lane and replays captured custom input as ordinary user input, so it cannot create a second protocol Delivery proof.

## Outcomes & Retrospective

Answer retrieval now retires scheduler-held Delivery, yields to frozen/direct reservations, and is re-arbitrated immediately before native tool-result commitment. Steer freeze revalidates proof before runtime handoff, and stale continuations cannot dispatch a changed queue head or batch. Added deterministic `agent_wait`, retry, direct-first, retrieval-first, and stale-callback regressions.
