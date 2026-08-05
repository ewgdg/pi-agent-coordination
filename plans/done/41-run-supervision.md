# Observe, interrupt, resume, and terminate exact Runs

## Goal

Implement issue #41 as the complete scoped Run-supervision path: authorized Workflow Owners and Direct Spawners can passively observe bounded Agent state, establish an exact-Run Interruption Hold, resume that exact Hold through model-visible supervisory or native human input, and terminate one exact current Run without mutating Agent identity or descendants.

## Intention

Keep authority and scheduling above the concrete in-process host while the host owns exact Run and Hold mechanics. Serialize every observation-sensitive mutation through the target Agent lane, use Pi transcript commitment as the only Message Delivery proof, and keep Holds, scheduling, selection, and termination outcomes volatile.

## Scope and constraints

- Preserve the ordinary authority tree. A Direct Spawner may control only an immediate child; the Workflow Owner may control verified ordinary descendants; no ordinary Agent controls itself, its parent, a sibling, or the Owner Run.
- Extend bounded status with the authorized primary Pi transcript location and an append watermark. Never expose prompts, payloads, raw Pi sessions, events, or history summaries.
- Bind each Interruption Hold to one exact Run handle and one unique hold incarnation. Interruption waits for semantic settlement and clears Pi queues that would otherwise continue after abort.
- Preserve admitted coordination Messages while held. They continue to consume ordinary bounded capacity but cannot commit Delivery, invoke the model, or clear the Hold.
- Give one Supervisory Resume Message a reserved per-Agent slot outside ordinary Message capacity. It commits alone, clears only its bound Hold, and starts one isolated turn before ordinary coordination backlog.
- Treat a native human editor Message submitted against a Hold through the same commit-bound exact-Hold transition and isolated-turn rule.
- If a bound resume becomes stale, retain it as ordinary Steer direction; it never clears a later Hold.
- Termination fences and confirms the exact current Run, discards its uncommitted scheduler and native input, bypasses every Retention Reason, and reports complete live incoming and outgoing residual Request counts.
- Do not roll back effects, Answer or cancel Requests, notify participants, affect descendants, control the Owner Run, prevent successor Runs, or create Agent lifecycle evidence.
- Keep the implementation greenfield. Prior prototypes are behavioral evidence only; do not retain compatibility or migration paths.

## Confirmed public test seams

1. Role-bound `WorkflowCoordinator` views over real temporary Pi `SessionManager`s and `AgentSession`s for authority, status, exact Hold state, Run control receipts, scheduling order, native input, successor Runs, descendants, and residual counts.
2. Registered `agent_observe` and `agent_control` tools reached through committed native Pi tool calls for strict schemas, caller-bound authority, source-derived resume identity, and model-visible receipts.
3. Reopened recipient transcripts for standalone Supervisory Resume Delivery, stale-resume behavior, human user-message commitment, backlog order, and termination discard.
4. Existing narrow boundary hooks only where a stale exact-Hold race cannot be deterministically observed through the higher seams.

## Work plan

1. Add bounded primary evidence to semantic Agent observation and cover owner, child, descendant, and direct-child authorization.
2. Add exact Run/Hold mechanics to the concrete host, including queued-input fencing, Human Request interruption, Hold retention, and isolated resumption state.
3. Extend the Message scheduler with held-delivery gating, a reserved Supervisory Resume slot, standalone commit, stale binding behavior, and post-isolation backlog release.
4. Add the role-bound Run-control coordinator and strict `agent_control` tool surface with committed resume Message reconstruction and typed receipts.
5. Route native human editor input through exact-Hold admission and commit while preserving native Pi user-message behavior.
6. Add termination fencing, scheduling discard, residual Request counts, descendant independence, and later successor coverage.
7. Document observation and Run supervision under `docs/`, then update package guidance.
8. Run focused tests and typechecking throughout, then the full suite, build, package dry run, production audit, and diff checks once.
9. Review Standards and Spec independently against `ff9296e`, repair findings, revalidate, move this plan to `plans/done/`, and commit semantically with `Closes #41` as the first body line.

## Validation

- `node --test tests/run-supervision.test.ts`
- `node --test tests/human-request.test.ts`
- `node --test tests/message.test.ts`
- `node --test tests/agent-request.test.ts`
- `node --test tests/agent-spawn.test.ts`
- `node --test tests/owner-workflow.test.ts`
- `node --test tests/host-shape.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm pack --dry-run`
- `npm audit --omit=dev`
- `git diff --check`

## Progress

- [x] Inspected issue #41, parent specification #34, current domain language, completed #35-#40 plans, Pi 0.83.0 session behavior, and prior in-process supervision evidence.
- [x] Confirmed the issue-level coordinator/tool/transcript TDD seams.
- [x] Bounded observation and authority slice.
- [x] Exact interruption and held-scheduling slice.
- [x] Supervisory and human resumption slice.
- [x] Exact termination and successor slice.
- [x] Documentation and full validation.
- [x] Independent Standards and Spec review.
- [x] Semantic commit.

## Decisions

- Use a unique volatile Hold handle in addition to the Run handle because the same retained `AgentSession` can be interrupted, resumed, and interrupted again.
- Keep ordinary Message capacity and the one resume reservation separate. A resume reservation never evicts or consumes ordinary pending capacity.
- Keep Run control in a dedicated coordinator module. The concrete host knows exact Run/Hold mechanics; the Message scheduler knows delivery eligibility; the role-bound coordinator owns authority and receipts.
- Use Pi's native user Message path for human resumption. The identity-bound `input` hook handles only input admitted against a current Hold and lets ordinary native input continue unchanged.
- Preserve the transcript as the only durable authority. Interruption Holds, exact Run handles, pending scheduling, and termination receipts are not appended as synthetic protocol records.

## Surprises and discoveries

- Pi's `abort()` waits through `agent_settled`, but queued Steer/follow-up input can otherwise cause automatic continuation after abort. Interruption therefore has to clear and hold queued input before waiting for settlement.
- Pi persists a custom or user input synchronously after its awaited `message_end` extension hooks and session listeners, before the model call. A narrowly bound post-persistence microtask can establish the exact commit transition without replacing Pi transcript or model-loop ownership.
- Pi catches an `input` extension error and continues ordinary prompt processing. A failed human resumption must therefore restore the exact Hold attempt, report the error, and explicitly handle the input so it cannot fall through to the model.
- The current host already preflights private runtime rebinding needed for native session selection, but product selection has not yet been wired. Run supervision must not mistake model authority for human presentation authority.

## Outcomes and retrospective

Issue #41 now has one complete Run-supervision path. Bounded observation includes the primary transcript location and append watermark; authority follows only Owner-descendant and immediate Direct-Spawner relationships. Exact Holds stop every ordinary delivery kind, and supervisory or human resumption clears only its committed bound Hold for one isolated turn. Termination discards exact-Run scheduling, reports residual Request counts, leaves descendants and Agent identity intact, and permits a successor Run. `/agents` switches retained live sessions and restores Owner selection for shutdown.

The first independent review found six Standards issues and two Spec issues. The repair centralized and documented transcript-commit observation, made failed resumption non-fallthrough and retryable, removed unused selection state, clarified the authority helper, named the test polling bound, and added admission-first interruption coverage. Standards and Spec re-review found no remaining regression.

Final validation passed with 89 tests: `node --test tests/run-supervision.test.ts`, `npm test`, `npm run typecheck`, `npm run build`, `npm pack --dry-run`, `npm audit --omit=dev`, and `git diff --check`.
