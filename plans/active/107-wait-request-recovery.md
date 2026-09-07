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
- Fresh worktree created from origin/main (`dd7418f`). Implementation complete in two meaningful commits.

- Detection regression: `npm run test:fast -- --file=answered-dependency-deadlock.test.ts` fails against original source (0 moderation attempts instead of 1), passes with unanswered graph projection. Genuine unanswered Owner dependency prevents moderation; upstream dependant stays outside normalized cycle. `dependency-deadlock.test.ts` and `npm run typecheck` pass.

- Wait regression: `npm run test:fast -- --file=wait-request-recovery.test.ts` first failed with no recipient Delivery after passive recovery. Shared scheduling reconciliation made it green. Further red/green slices proved Answer notification must not queue behind recipient maintenance, independent recipient lanes must progress concurrently, and late maintenance failure must not overwrite a preempted result. The file now has 15 passing seam tests.
- Updated supported behavior and generated Wait guidance. Replaced the dormant-rejection supervision test with delivered-work/no-revival coverage. The selected-child human-preemption fixture now holds an admitted delivery dispatch rather than relying on scheduling loss that Wait deliberately repairs.

## Decisions and lifecycle semantics

The user selected automatic same-identity recovery for ordinary lost scheduling. MessageCoordinator now creates one volatile reconciliation closure for the fixed Wait snapshot, sharing its lane-level Request reconciliation and existing delivery scheduler with explicit retry. No new protocol identity, authored retry call, cold replay, queue reconstruction, retry configuration, or scheduler implementation is introduced.

- Explicit fresh Wait may admit an undelivered Request to a Dormant responder normally, including a Creation Request. Delivered Requests never wake a Dormant responder; committed Answers are retrievable independently of responder phase.
- Capture exact recipient handles (or the dormant recipient's latest Run sequence) before maintenance. After initial admission, reconcile only within those Runs. Ending, failed, terminated, or replaced Runs cannot be revived by the ongoing Wait. A new explicit Wait renews intent.
- Existing Holds and causal blocking remain scheduler-owned. Existing pending/frozen/dispatched work coalesces. Request cancellation is checked inside the recipient lane and never replays work; cancellation of a captured Request retains the existing error completion of the join.
- Answer proof is checked before awaiting asynchronous delivery maintenance. Notifications can complete/preempt Wait while a lane is busy. Per-recipient lanes remain concurrent; within each lane, snapshot authoring order is retained. Caller fencing/preemption ends readmission authority; late maintenance errors cannot invalidate a completed/preempted candidate.
- If authoritative inspection or admission cannot establish delivery progress, report the affected Request and reason, without unattended backoff or swallowing the failure.

## Validation results

All commands use the project harness; the full integration suite was not run.

- `npm run typecheck` and `git diff --check`: pass.
- `npm run test:fast -- --file=answered-dependency-deadlock.test.ts`: 2 pass (red against original detection source, green after graph fix).
- `npm run test:fast -- --file=dependency-deadlock.test.ts`: 3 pass.
- `npm run test:fast -- --file=request-evidence.test.ts`: 7 pass.
- `npm run test:fast -- --file=wait-request-recovery.test.ts`: 15 pass; recovery, same-Run loss, Hold, dormant admission, later termination, cancellation, Delivery/Answer proof, frozen and in-flight coalescing, evidence failure, sibling ordering, Creation Requests, caller fences, and asynchronous maintenance races.
- `npm run test:process -- --file=agent-request.test.ts '--test-name-pattern=Wait|retry|Retry|cancel'`: 17 pass.
- `npm run test:process -- --file=run-supervision.test.ts '--test-name-pattern=Agent Wait'`: 1 pass.
- `npm run test:process -- --file=operational-incidents.test.ts '--test-name-pattern=cycle|Deadlock'`: 3 pass.
- `npm run test:process -- --file=cold-host-recovery.test.ts '--test-name-pattern=fresh Owner host rediscovers one dormant child|reopen derives ordinary Request evidence'`: 2 pass.
- `npm run test:fast -- --file=participant-tool-registrar.test.ts '--test-name-pattern=Wait|guidance|prompt|metadata'`: 5 pass.

## Surprises and discoveries

The full targeted `participant-tool-registrar.test.ts` file has one unrelated pre-existing failing Spawn-description assertion: it expects “Omit template and config” in the conversation-field description. Reproduced the same failure with the original `dd7418f` tool source restored temporarily in this worktree, then restored the task source. Left that unrelated schema/test mismatch unchanged.

## Outcomes and handoff

Initial implementation, documentation, targeted validation, and task-owned commits were handed off. Independent review found two delivery-progress interactions; the plan is reopened for their bounded fixes. Parent owns further review, push, and PR publication; this worktree has not changed the live workflow or parent checkout. Review should focus on exact-Run authority in the shared reconciliation closure and Answer/preemption arbitration while asynchronous maintenance is pending.

## Model-facing description follow-up

The user requested renewal intent at the tool-description interface without duplicate guidance. Moved the concise behavior into `agent_wait.description` and removed its explanatory prompt-guide paragraph. The role-specific tool-metadata contract test went red before the description change; all five focused Wait/guidance/prompt/metadata tests, typecheck, and diff checks pass afterward. Lifecycle detail remains in the supported-behavior docs.

## Independent-review fixes

1. Fixed: inspecting an already delivered Request on a Dormant responder consumed the initial-admission flag and stranded a later undelivered sibling. Removed that redundant flag: only an actual Run start changes the captured handle/sequence fence. The regression fails before the fix (responder remains Dormant), then verifies normal startup, causal sibling ordering, both original Request Deliveries, and completed Answer proof. `npm run test:fast -- --file=wait-request-recovery.test.ts`: 16 pass; typecheck and diff check pass.
2. Pending: shared in-flight maintenance across the whole snapshot lets one busy recipient lane suppress subsequent recovery passes for other recipients. Move coalescing to each recipient and keep periodic reconciliation independent of slow lanes. Add regression and focused ending/failure/replacement lifecycle controls.
