# Moderate obligated work blocked by stranded Delivery

## Goal and intention
Detect missing delivery progress upstream of undelivered work, without treating ordinary model or Wait duration as a timeout.

## Scope and constraints
Issue #89; #75 remains the broader lifecycle containment decision. Add only moderation-boundary containment and passive Owner attention. No scheduler recovery, automatic Message retry, malformed-call race fixes, new Moderator authority, or protocol identity changes.

## Design
Observe scheduling, reservation and dispatch transitions separately from transcript Delivery proof. Capture a configurable delivery progress interval at admission. Suspend intervals during legitimate dependency waits; restart upon regained eligibility. Repeated observations are not progress. Known lost continuation is immediately suspicious. Trace outstanding Requests from unresolved obligations, including parked Wait, to blocked delivery; exclude Human attention, selection and Holds. Normalize handling by blocked Message, use existing two-attempt bound.

## Work plan
1. Read domain, moderation/policy, Pi lifecycle docs, existing tests.
2. Add public Workflow/Pi regression for upstream Creation Request dispatch failure; run red.
3. Implement progress observation, graph qualification and bounded moderation.
4. Add controlled-clock deadline, progress, exclusions, recovery and fallback regressions.
5. Update operational/domain/policy docs; targeted tests and typecheck; move plan to done.

## Validation
Approved seams: public Workflow views and Pi session transcripts, controlled scheduling boundary hooks and controllable clock. No private-field tests. Existing moderation authority/failure tests remain applicable.

## Progress
- Read #89 and #75, existing scheduler/incident contracts and TDD skills.
- Existing scheduler already has explicit retry/coalescing recovery behavior; left it unchanged.
- First public regression failed with “Expected a delivery_stall Moderator” before implementation.
- Implemented admission/reservation/dispatch observation, Request-path qualification, bounded handling and policy.
- Added real Workflow/Pi controlled-clock regressions covering parked parent, startup failure, deadlines, reservation reset and captured policy reload, no automatic retry/duplicate proof, selection/Hold/Human exclusions, existing obligations, real capacity waiting, recurrence and final obligation clearance.
- Added scoped detector/bootstrap failure containment, diagnostic pointers and independent inspection watchdog.
- Updated operational moderation, Workflow Policy, domain vocabulary and README.

## Decisions
- Deadline suspension discards the current interval, rather than charging legitimate wait time.
- Detection is observational; transcript evidence alone proves Delivery.

## Validation results
- `npm run typecheck`: passes.
- Targeted `tests/operational-incidents.test.ts` selection: 18/18 passed (new delivery/moderation tests plus existing Resolution, authority, bootstrap and two-failure-bound cases). Additional before-admission Creation Request regression: 1/1 passed. Subsequent watcher containment cross-check: 4/4 passed.
- `tests/workflow-policy.test.ts`, `tests/control-protocol-schemas.test.ts`, `tests/message-delivery.test.ts`, `tests/operation-review.test.ts`, `tests/operational-incident-surface.test.ts`: 22/22 passed.
- `git diff --check`: passes.
- Did not run the complete integration suite.

## Surprises and discoveries
`tests/operational-reconciliation.test.ts` has four existing fixture failures (“Creation Request ... has no reconstructed spawn input”). Confirmed against an isolated archive of unchanged HEAD `ecec91db6f0e0b2697977b51bc0093811fb06f68`. No fixture correction was folded into this feature; its only edit wires the new diagnostic sink. Test logs live under `~/.agents/artifacts/outputs/pi-agent-coordination/` in the dated `89-blocked-delivery-moderation` output.

## Outcomes and retrospective
Implemented #89 without scheduler recovery, automatic Message Retry, malformed evidence race changes, or expanded Moderator authority. One blocked Message aggregates qualifying upstream obligation paths; pending retention is not sufficient evidence of progress. Watchers and handling are volatile and not cold-reconstructed. Existing committed Moderator attempts remain bounded at two.

The #75 boundary is intentionally narrow: moderation inspections and bootstrap failures become passive Owner attention, while broader participant lifecycle fencing/cleanup remains a separate decision. A precommit creation exception now retains faulted handling until condition clearance. It consumes no committed attempt and does not permit repeated staging on heartbeats or unrelated changes. A still-running preparation that exceeds its watchdog may finish; both initial and terminal-failure replacement preparation receive timed containment.


## Review follow-up
- Reproduce replacement preparation lacking a watchdog, unbounded precommit staging on heartbeats, and stranded Delivery observation lost on termination with public-boundary regression tests.
- Give initial and replacement preparation the same timed containment; retain faulted handling until the continuous condition clears; preserve observation of stranded Requests through Run termination.
- Update the precommit test contract and operational guidance, then run targeted validation.

- All four first-pass review regressions failed before the fix: repeated staging (2 and 4 attempts), missing post-termination Delivery Stall, and missing replacement watchdog attention.
- Implemented a shared timed moderation-pass boundary and creation-attempt containment. Faulted handling remains retained; nested replacement failure cannot be dismissed by its successful outer call.
- Termination now records known lost delivery progress rather than disposing the observation. The real parked-parent test confirms no Request cancellation or automatic recipient restart.
- Added a fifth regression for synchronous replacement bootstrap failure, plus condition-clearance/recurrence assertions proving the next committed bootstrap has no previous-attempt pointer.
- Targeted review regressions: 5/5 pass.
- Final review validation: 21/21 targeted delivery/moderation lifecycle tests, 22/22 policy/schema/delivery/review/surface tests, and 2/2 Operation Review/Moderator authority cross-checks pass. Typecheck and diff-check pass. No full integration-suite run or commit. Review red/green and validation logs are retained beside the original task evidence.
