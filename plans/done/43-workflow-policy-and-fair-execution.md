# Apply Workflow Policy and fair execution scheduling

## Goal

Implement GitHub issue #43 so one strict Owner-scoped user policy controls prospective ordinary execution admission, per-recipient pending Message capacity, and the future Operation Review interval without creating transcript state or rewriting already-admitted work.

## Intention

Keep policy ownership and scheduling separate. A small policy module strictly reads `<getAgentDir()>/config/pi-agent-coordination.json`, publishes frozen complete snapshots atomically, and reports reload diagnostics without partial fallback. A Workflow-wide scheduler captures the current snapshot when a Pi Agent execution reaches its awaited `agent_start` boundary, admits ordinary Runs in FIFO order, exempts Moderators, and releases capacity when generation and tools reach `agent_end`.

## Scope & Constraints

- Implement issue #43 only. Expose `operationReviewIntervalMs` in snapshots for issue #48, but start no timer or Moderator behavior.
- Defaults are `maxConcurrentAgentRuns: 8`, `maxPendingDeliveriesPerAgent: 256`, and `operationReviewIntervalMs: 600000`.
- Policy is one strict UTF-8 JSON object at the user Pi agent configuration path. No package/project merge layer, transcript evidence, compatibility aliases, migration handling, or hidden fallback after malformed content.
- Reject duplicate or unknown keys, non-JSON syntax, wrong types, non-positive or unsafe concurrency/delivery integers, and review intervals outside 1,000 through 2,147,483,647 milliseconds.
- Owner reload publishes one whole frozen snapshot or preserves the previous one with resource diagnostics. Child reload never owns or changes Workflow Policy.
- Every ordinary execution or new distinct delivery admission reads one complete snapshot at admission. Existing executions and admitted Messages retain their outcome across reload.
- Reductions never preempt or evict. A queued ordinary execution starts only when current usage is below that execution's captured limit. FIFO prevents later admissions from bypassing an earlier waiter.
- Count an ordinary Owner or child Run only from awaited `agent_start` admission through `agent_end`. Queued, settled, held, input-required, ending, and dormant Runs consume no slot. Moderator admission is immediately exempt.
- TDD seams are pre-agreed by issues #43, #26, and #34: strict policy parsing/loading, the Workflow-wide execution scheduler contract, bootstrap/reload through the real extension harness, and role-bound `WorkflowCoordinator` behavior with real in-process Pi sessions.
- Preserve the existing user work at commits `4cb9623` and `d9db962`; the implementation fixed point is `d9db962`.

## Work Plan

1. Add strict policy parser/loader/store tests, then implement frozen defaults, complete validation, the exact user path, and atomic publication.
2. Add bootstrap tests for missing/default, invalid initial, valid Owner reload, invalid atomic reload, and transcript/configuration non-mutation; wire initial and reload ownership before coordinator creation/rebinding.
3. Add one FIFO scheduler behavior at a time: ordinary cap, fair release, captured-limit reduction, aborted waiter removal, and Moderator exemption; implement the minimal scheduler and lease contract.
4. Integrate scheduler admission/release with every ordinary Agent's hidden extension at Pi's awaited `agent_start`/`agent_end` boundaries, then prove Workflow-wide contention with real Owner/child sessions.
5. Replace the fixed Message scheduler limit with the current policy snapshot at each distinct admission; prove same-identity coalescing, exhaustion, lower-limit preservation, and later raised capacity.
6. Document Workflow Policy location, exact schema, validation, reload, prospective semantics, and execution/delivery behavior under `docs/`.
7. Run focused tests and typechecking throughout, then full tests, build, package dry run, audit, and diff checks once. Run independent Standards and Spec reviews against `d9db962`, repair findings, revalidate, and commit semantically with `Closes #43` in the body.

## Validation

- Focused policy parser/bootstrap tests.
- Focused execution scheduler and coordinator integration tests.
- Focused Message capacity/reload tests.
- `npm run typecheck` during implementation.
- Final `npm test`, `npm run typecheck`, `npm run build`, `npm pack --dry-run`, production dependency audit, and committed-diff whitespace check.
- Two-axis review against `d9db962`; Standards sources are `AGENTS.md`, `CONTEXT.md`, existing docs/plans, and the repository smell baseline. Spec sources are issues #43, #26, and #34.

## Progress

- [x] Inspect issues #43, #26, and #34, current architecture, Pi lifecycle hooks, and existing test seams.
- [x] Fix the public TDD seams and implementation design.
- [x] Implement strict policy validation, loading, and atomic Owner reload.
- [x] Implement fair ordinary execution admission and Moderator exemption.
- [x] Apply prospective Message delivery capacity.
- [x] Document the completed Workflow Policy contract.
- [x] Run the complete validation gate.
- [x] Independently review, repair, revalidate, and commit.

## Surprises & Discoveries

- Pi's `agent_start` extension event is awaited before `turn_start` and the provider request for every `AgentSession` run path, including custom Message-triggered turns. `before_agent_start` is not sufficient because `sendCustomMessage(..., { triggerTurn: true })` bypasses it.
- Pi core keeps a queued execution abortable through the active Agent signal while awaited `agent_start` handlers are pending, so a scheduler waiter can be removed without consuming a slot or blocking exact-Run termination until unrelated capacity opens.
- Issue #26 fixes the exact policy filename and removes earlier candidate names: `maxConcurrentAgentRuns`, `maxPendingDeliveriesPerAgent`, and `operationReviewIntervalMs` are the complete surface.
- A sequential Human Request remains one running Pi tool call while waiting, so `agent_end` alone cannot define policy usage. Human Request admission now suspends its permit, and the first post-result tool or turn boundary reacquires capacity before work continues.

## Decisions

- Use one atomic in-memory policy store shared by bootstrap, execution scheduling, and Message delivery. The store contains only frozen complete snapshots and is not durable authority.
- Gate all ordinary Pi execution at `agent_start` and release at `agent_end`; this is the smallest complete seam covering native prompts, Deferred/Steer continuations, retries, and custom Delivery turns without wrapping Pi internals.
- Suspend ordinary execution capacity after an exact Run enters `input_required`; reacquire only after committed Human Request result reconciliation and before the next tool or model boundary.
- Queue each ordinary admission with its captured complete snapshot. Drain only from the FIFO head and compare current usage to that head's captured limit.
- Use strict native `JSON.parse` for JSON syntax and the existing YAML parser only to detect duplicate mapping keys that native JSON parsing otherwise loses.

## Outcomes & Retrospective

Issue #43 is implemented as one Owner-scoped policy store shared by execution and Message admission. The delivered behavior includes strict all-or-nothing policy loading and reload, Workflow-wide FIFO ordinary execution capacity, Moderator exemption, input-required capacity suspension, and prospective per-recipient pending Delivery limits. The future Operation Review interval is validated and exposed without starting issue #48 behavior.

The final gate passed 113 tests plus typecheck, build, package dry run, production dependency audit, and committed-diff whitespace validation. Independent Standards and Spec re-reviews found no remaining issues after explicit `null` validation coverage and removal of test-only result surfaces.
