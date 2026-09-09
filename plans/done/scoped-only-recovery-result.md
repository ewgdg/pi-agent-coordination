# Scoped-only workflow recovery result
## Goal
Expose only workflowId and recipient-relative outstandingRequests to the Owner. Render Request/target/status/reason directly without a global operational envelope.
## Constraints
Preserve scheduling behavior and admission timing. No compatibility fields. Keep external working-tree changes untouched.
## Work
- Test-first exact Owner result shape and renderer regressions.
- Move scheduling outcome types into coordination and retain only evidence needed to derive scoped status.
- Replace global receipt assertions with scoped status or observable Delivery/suppression assertions.
- Update maintained recovery guidance and verify focused tests/typecheck.
## Progress
Exact-result regression failed on the three global fields before implementation. Coordinator and type changes implemented; 21 workflow resume tests pass. Renderer delegated as a disjoint two-file change.
## Decisions
Parent approved releasing all recipients with allSettled before surfacing a dispatch failure. Error explicitly warns that work may already be admitted or dispatched; frozen admission-time views remain unchanged.

## Completed validation
- Owner exact-result and release-error wording regressions failed before their changes.
- Renderer tests cover compact and expanded Request/target identities, status/reason rows, warning summary, empty recipient-relative view and errors.
- 73 focused tests passed across workflow-resume, workflow-resume-renderer, workflow-continuation, participant-tool-registrar, owner-parked-delivery-scheduler and child-runtime-settlement-continuation.
- Typecheck and diff whitespace checks passed.
- Existing scoped blocked/unavailable/running/admitted and nested/cyclic scheduling regressions remain passing. Public-envelope tests now assert scoped status or observable delivery and suppression.
- Full integration suite intentionally not run. No scheduling redesign; release errors now explicitly surface partial effects as approved.
