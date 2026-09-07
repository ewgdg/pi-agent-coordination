# Restore Request progress during Wait and detect genuine deadlocks

## Goal and intention

An explicit Agent Wait renews intent for its captured Requests. It ensures that unanswered, undelivered Requests retain same-identity delivery scheduling, instead of requiring the model to repair an internal lost queue. Independently, deadlock detection must ignore answered dependencies even while their Answers await requester Delivery.

## Scope and constraints

- Fix GitHub issue #107: answered-but-undelivered Owner edges must not hide a closed core/publication cycle.
- Add Request delivery reconciliation behind the shared messaging/scheduling interface; Wait invokes it for its fixed foreground-owned snapshot.
- Re-admit the original identity only after authoritative absence of Delivery and existing scheduling. Preserve payload, recipient, ancestry, and context preparation.
- Already answered: retrieve through normal Wait semantics. Already delivered: never re-deliver. Queued, reserved, frozen or in-flight: coalesce, do not duplicate. Causally blocked queues remain scheduled and keep ordering.
- Preserve cancellation, Holds and exact-Run fences. Do not undo intentional stopping through an unattended retry loop. Cold bootstrap stays passive; a new explicit Wait supplies renewed intent.
- Do not automatically replay ordinary Messages or unrelated Requests. Do not change all-answer snapshots or remove canonical Delivery proof requirements.
- Use meaningful separate commits for detection and Wait recovery. No adjacent cleanup or changes to the live Dotman workflow.

## Work plan

1. Write the detection regression at the incident reconciliation seam; show red, correct unanswered graph projection, show green, commit.
2. Write the recovery regression through Agent Wait and shared message delivery after a fresh coordinator restores canonical Request relationships. Show red, implement shared same-identity scheduling reconciliation, show green.
3. Add focused behavioral controls for existing scheduling/Delivery/Answer, cancellation, causal blocking and lifecycle boundaries. Keep tests deterministic and bounded.
4. Update supported behavior in messaging/recovery docs and agent guidance where relevant. Remove superseded explicit-retry-only Wait instructions rather than keeping compatibility paths.
5. Targeted validation and independent review; address findings, mark this plan done, hand commits to parent for publication.

## Validation

The agreed observable seams are (a) normalized Dependency Deadlock moderation attempt for the core/publication scenario, and (b) Wait-driven recovery producing exactly one original Request Delivery and completing through ordinary Answer proof. Reuse real coordination test fixtures, not private-method mocks or production snapshot files. Test important exclusions at those seams. Do not run the full integration suite. Run typecheck and focused affected tests; capture red/green commands and results.

## Evidence

Issue: https://github.com/ewgdg/pi-agent-coordination/issues/107

The investigation reproduced both defects against `dd7418f`. An old Request was canonical and unanswered but never delivered; cold recovery intentionally restored relationships without scheduling. The existing Wait guard checked only dormant recipients. Explicit same-identity retry produced one Delivery. In the incident graph, a committed-but-undelivered Owner Answer falsely opened the core/publication cycle because Owner host binding excluded Owner from eligible members.

## Progress

- Diagnosis complete; root causes reproduced using real coordination modules.
- Fresh worktree created from origin/main (`dd7418f`). Detection implemented.

- Detection regression: `npm run test:fast -- --file=answered-dependency-deadlock.test.ts` fails against original source (0 moderation attempts instead of 1), passes with unanswered graph projection. Genuine unanswered Owner dependency prevents moderation; upstream dependant stays outside normalized cycle. `dependency-deadlock.test.ts` and `npm run typecheck` pass.

## Decisions and open details

The user selected automatic same-identity recovery over fail-fast for ordinary lost scheduling. Implement this as a deep shared delivery capability rather than a tool-level retry loop. Final lifecycle behavior must be explicit and consistent: do not silently override cancellation or an intentional stop while a Wait remains parked; flag any ambiguity requiring a product decision.

## Outcomes

Pending implementation and review.
