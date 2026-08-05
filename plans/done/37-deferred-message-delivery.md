# Deliver and retry Deferred Messages across dormant Runs

## Goal

Give authenticated same-Workflow ordinary Agents one complete Deferred Message path: source-derived authoring, volatile recipient-lane admission, model-visible transcript Delivery, polling, same-identity retry, exact child Idle closure, and Message-triggered successor Run startup.

## Intention

Keep Pi transcripts as the only durable authority while making live scheduling deliberately disposable. The sender's committed `agent_message` call owns the immutable Message; a recipient Delivery is the only delivery proof. One per-Agent lane resolves every close/delivery race without a mailbox, replay reducer, timeout inference, or attempt identity.

## Scope and constraints

- Add the `send`, `poll`, and `retry` Deferred-only slice of the role-bound `agent_message` tool. Requests, Answers, cancellation, Steer, interruption/resume, controls, cold-host rediscovery, policy limits, and moderation remain later issues.
- Derive Message identity, sender, Workflow, recipient, and payload from the exact committed source tool call. The model supplies no identity or sender.
- Apply the canonical Message crash table: a matching normal author result or valid Delivery ratifies creation; absence of both is indeterminate; an error result means no Message unless a Delivery exists, which is an invariant violation.
- Store no durable queue, acceptance state, attempt identity, receipt rewrite, replay marker, or automatic retry. Pending delivery state is host-local and discarded with its exact Run/host boundary.
- Keep the Workflow Owner host-bound. Only child Runs use automatic release and dormant successor startup.
- Treat Message delivery mode as fixed Deferred for this slice, including retry.
- Keep source modules focused: protocol evidence/validation, volatile delivery scheduling, and Run lifecycle/release policy must not accumulate in one coordinator file.
- Preserve the #36 Creation Request behavior and route its live admission through the same Deferred scheduling machinery where that reduces duplicate race logic.

## Public test seams

1. Role-bound `WorkflowCoordinator` views backed by real temporary Pi `SessionManager`s and `AgentSession`s: send/poll/retry receipts, authorization, child status, and shutdown behavior.
2. The registered `agent_message` tool reached through a real committed Pi tool call: hidden caller authentication and source-derived immutable Message data.
3. Reopened recipient transcripts: exact Delivery projection, all-branch proof lookup, append watermarks, first-proof-wins, and the canonical author-result/Delivery crash table.
4. Controllable concrete boundary gates around lane admission, Delivery commit, release evaluation, and Run end: ordering, stale candidates, confirmation loss, duplicate racing retries, and volatile-backlog discard without a fake backend.

## Work plan

1. Add strict ordinary Message source/result/Delivery evidence parsing and validation, including append watermarks and crash-table classification.
2. Introduce modular child Run lifecycle and Deferred scheduling components around the existing per-Agent serial lane; refactor spawning to install restartable child bindings and use the common admission path.
3. Implement `agent_message` send, poll, and retry vertically through the role-bound coordinator and hidden Agent extension.
4. Add focused red-green integration slices for canonical authoring/delivery, polling/authorization, retry coalescing/deduplication, release ordering, stale close candidates, dormant restart, and discarded volatile scheduling.
5. Update concise feature documentation under `docs/`, then run focused tests and typechecking throughout.
6. Run the full test suite, build, package dry run, production audit, and diff checks once; run independent Standards and Spec reviews from the pre-change fixed point; fix findings and revalidate.
7. Move this plan to `plans/done/` and commit semantically with `Closes #37` as the first body line.

## Validation

- `node --test tests/deferred-message.test.ts`
- `node --test tests/agent-spawn.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm pack --dry-run`
- `npm audit --omit=dev`
- `git diff --check`

## Progress

- [x] Inspected issue #37, the current #35/#36 implementation, and normative decisions from issues #6, #7, #9, #14, and #22.
- [x] Confirmed the coordinator/real-Pi integration seam from #37 as the pre-agreed TDD seam.
- [x] Protocol evidence and canonical crash-table slice.
- [x] Volatile Deferred scheduling and child Run release/restart slice.
- [x] Role-bound tool surface and receipts.
- [x] Documentation and pre-review full validation.
- [x] Independent Standards and Spec review; repaired every finding.
- [x] Focused post-review typecheck, Deferred Message suite, Agent Spawn suite, and diff checks.
- [x] Final post-review full validation and packaging inspection.

## Decisions

- Implement only free-form ordinary Deferred Messages in `agent_message` now. The richer Request/Answer/cancellation and Steer variants remain issues #39 and #38.
- Follow issue #37's fixed-mode retry requirement. The earlier invocation-selectable retry mode is superseded for this implementation slice.

## Surprises and discoveries

- A successfully delivered Creation Request correctly retains its child Run with `answer_owed`; issue #39 owns resolving that obligation. Release/restart tests therefore also need the valid post-Identity path where Creation Request scheduling did not commit and no Request obligation retains the Run.

## Outcomes and retrospective

- Deferred `agent_message` now supports source-derived `send`, sender-authenticated `poll`, and same-identity `retry` with exact transcript proof validation.
- Delivery scheduling is host-local and disposable, with volatile queue, exact-Run settlement, and release policy isolated in one focused scheduler module; a child Agent now survives dormant gaps and receives Deferred work on successor Run startup through one serialized lane.
- Creation Request delivery now shares the same live admission, proof lookup, release ordering, and discard behavior as ordinary Deferred Messages.
- Confirmation loss after send or retry admission reports `indeterminate` without cancelling the admitted Delivery; malformed or unknown coordination evidence and started-Run protocol contradictions fail as invariants.
- Run failure and Workflow shutdown both discard admitted but uncommitted scheduling, with regressions proving that backlog never transfers.
- Validation covers typecheck, targeted suites, full tests, build, package dry run, audit, and diff checks.
