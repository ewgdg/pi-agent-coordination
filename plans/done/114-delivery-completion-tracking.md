# Delivery completion tracking

## Goal and constraints
Track the actual dispatched Request through native settlement, even when a preparation replacement finishes first. Preserve native lifecycle events, transport cycles, logical Run retention/release policy, and queued-active delivery semantics. No admission settlement guard.

## Work plan
1. Reproduce fast replacement premature completion with real Pi, bridge, and hosted adapter.
2. Correlate actual dispatch completion independently of the early transcript admission response.
3. Move scheduler completion waits outside its serial lane; revalidate exact Run and reservation on reentry.
4. Verify both replacement timing orders, cancellation/failure, stale tracking, and safe-boundary progress; document and commit.

## Validation
Targeted real Pi binding tests, scheduler regressions, hosted/process/control tests, typecheck. No full suite.

## Progress
- Rejected guard removed and backed up outside repository.
- Six real Pi/parent cases: three fast replacement regressions fail before fix; three still-active cases pass.
- Scheduler probe proves awaiting corrected prompt completion inside lane blocks actual turn_end safe boundary.
- Requester approved only moving that tracking wait out of lane with exact reservation/Run revalidation; no lifecycle or policy changes.

## Decisions
Completion correlation is independent of transport Run identity. An earlier cycle may legitimately settle before a fresh cycle starts. Scheduler may service safe-boundary callbacks while waiting; it must not reconcile stale reservations.

## Outcomes
- Bridge emits a per-Delivery correlated dispatch-completion event independently of early transcript admission.
- Hosted completion combines actual dispatch with the existing settlement waiter; queued-active semantics remain intact.
- Scheduler waits outside its lane, then validates exact Run/reservations before reconciliation. No lifecycle or retention/release policy changes.
- Six real Pi/bridge/hosted/scheduler cases preserve lifecycle traces and pass both replacement timing orders.
- 29 focused tracking/control tests, 15 hosted/ordering tests, and 11 real process tests passed; typecheck and diff check passed. No full suite.
- Documentation updated in docs/agent-messaging.md.

## Surprises and discoveries
The original premature completion also masked a lock cycle: actual Pi turn_end awaits the scheduler's safe-boundary lane, while an earlier settlement listener awaited full Delivery completion inside that lane. Only the tracking wait moved out; normal lane work can now proceed before reconciliation.

## Retrospective
Transport cycles and logical Agent Runs are separate. Correlating a dispatch Promise is sufficient; native lifecycle events need no admission hold.
