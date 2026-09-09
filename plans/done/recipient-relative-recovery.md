# Recipient-relative workflow recovery
## Goal and intention
Give each recovering recipient a truthful view of its own outbound Requests so it can avoid duplicate wake-ups.
## Scope and constraints
Preserve workflow-wide operational receipts for reporting, incoming obligation invariants, scheduler ownership and unrelated working-tree changes. No new Pi API dependency.
## Decisions
Parent approved a two-phase scheduler readiness barrier: admit first, finalize all scoped views, then release without awaiting other lanes from inside a lane.
## Work plan
1. Add failing scoped-view and notification timing regressions.
2. Snapshot Request identities and derive uniform outcomes.
3. Gate continuation dispatch until immutable views are ready; preserve suppression and admission ownership.
4. Update maintained docs and targeted verification; commit task-owned files.
## Validation
Target workflow resume/continuation tests and typecheck, including cycles, blocked/unavailable/running and admission timing.
## Progress
Architecture inspected; existing custom admission can dispatch immediately, requiring an explicit readiness gate.

## Completed implementation
- Added a shared recipient-scoped outstandingRequests contract to Owner receipts and runtime continuations; incoming Request IDs remain internal to admission/suppression.
- Retained Workflow-wide operational reporting for its existing inspection/rendering purpose.
- Scheduler readiness gates admission without holding lanes. Finalized frozen views precede dispatch, including cyclic dependencies; failure cleanup releases gates and normal cancellation/fencing remains authoritative.
- Generalized the existing delivery-eligibility notification used by Wait so recovery uses the same scheduler seam rather than adding a parallel wrapper.
- Shared concise recovery guidance and documented statuses and timing in docs/cold-host-recovery.md.

## Validation and outcomes
- Initial Owner-scoped regression failed before implementation (missing outstandingRequests).
- 69 targeted tests passed across workflow-resume, workflow-continuation, workflow-resume-renderer, participant-tool-registrar, owner-parked-delivery-scheduler, and child-runtime-settlement-continuation.
- Covered nested cyclic recipients, identical Owner/recipient entry shape, admission-before-notification, lane availability, running/held/unavailable targets, queued delivery status, partial admission failure, and gated cancellation suppression.
- npm run typecheck and git diff --check passed.
- Full integration suite intentionally not run. Recovery statuses describe admission-time facts, not future Delivery/completion.
- Updated the touched transport test's fixture to include the currently required deliveryId; no transport interface changed.

## Discoveries
An unfinished continuation gate must block queued sibling eligibility too, rather than merely filtering out the continuation, or sibling input can overtake recovery.
External concurrent changes appeared during work and were left out of task commits.
