# Steer Agents at safe boundaries with bounded scheduling

## Goal

Extend the working Message path with immutable Deferred or Steer authoring, safe-boundary Steer batching, and bounded per-recipient volatile scheduling without weakening transcript-backed delivery proof or receipt semantics.

## Intention

Use Pi's awaited `turn_end` extension boundary to freeze and queue one ordered Steer batch only after the current generation and its complete tool batch finish. Keep every scheduling item volatile, preserve the authored delivery mode across retry, and continue treating the recipient transcript as the sole Delivery proof.

## Scope and constraints

- Implement issue #38 only. Ordinary Request/Answer/cancellation behavior remains #39, Workflow Policy reload remains #43, and Agent Templates remain #42.
- Default omitted `deliveryMode` to Deferred; accept explicit Steer only at Message authoring. Retry remains mode-free and reconstructs the canonical authored mode.
- Keep Creation Requests fixed Deferred while routing them through the same bounded scheduler.
- Count distinct pending Message identities across both modes. Coalesce a same-identity retry, never evict admitted work, and reject capacity exhaustion without changing the canonical author Message.
- Freeze Steer items in recipient-lane admission order. Items admitted after the freeze wait for another safe boundary.
- Never abort generation or tools, roll back effects, or claim model processing.
- Use fresh generic Message and scheduler names rather than retaining Deferred-only names for generalized behavior.
- Keep tool registration/presentation thin and separate from coordination, protocol evidence, and Run lifecycle.

## Public test seams

1. Role-bound `WorkflowCoordinator` views over real temporary Pi sessions: authored/default mode, receipts, capacity, coalescing, Deferred/Steer priority, dormancy, failure, and shutdown.
2. The registered `agent_message` tool and its native renderers: schema, bounded preview, exceptional mode, identity, and typed disposition.
3. Reopened recipient transcripts: ordered batch projections, per-Message proof inside a batch, all-branch deduplication, and fixed-mode retry.
4. Awaited identity-bound `turn_end` handling with the deterministic faux model: freeze boundaries and completion of the already-issued tool batch before Steer becomes model-visible.
5. Existing concrete boundary hooks only where confirmation loss or a precise admission/freeze race cannot be observed deterministically through the higher seam.

## Work plan

1. Add the authored delivery mode vertically through tool schema, committed source validation, canonical reconstruction, and documentation; preserve Deferred behavior by default.
2. Generalize Message Delivery construction and inspection from single-item entries to ordered non-empty batches while retaining independent per-Message proof and duplicate rejection.
3. Replace the Deferred-only scheduler with one bounded per-recipient Message scheduler supporting Deferred, pending/frozen Steer, coalescing, capacity rejection, and safe release behavior.
4. Bind an awaited per-Agent `turn_end` hook through the hidden identity-bound extension and route it to the coordinator lane; prove Steer batching, post-freeze deferral, tool-batch completion, and Steer priority with deterministic real-session tests.
5. Add compact native `agent_message` call/result renderers without appending passive transcript content.
6. Update feature documentation, then run focused tests and typechecking throughout.
7. Run the full suite, build, package dry run, production audit, and diff checks once; perform independent Standards and Spec reviews against the pre-change commit, fix findings, and revalidate.
8. Move this plan to `plans/done/` and commit semantically with `Closes #38` as the first body line.

## Validation

- `node --test tests/message-delivery.test.ts`
- `node --test tests/message.test.ts`
- `node --test tests/agent-spawn.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm pack --dry-run`
- `npm audit --omit=dev`
- `git diff --check`

## Progress

- [x] Inspected issue #38, the completed #37 plan, current Message/scheduler/Run-host seams, and Pi 0.83.0 `turn_end`/Steer ordering.
- [x] Confirmed the issue-level public TDD seams and the #38/#39/#42 boundaries.
- [x] Authored mode and batched protocol evidence slice.
- [x] Bounded scheduler and safe-boundary Steer slice.
- [x] Native rendering and documentation.
- [x] Full validation and independent Standards/Spec review.

## Decisions

- Use `deliveryMode?: "deferred" | "steer"` in authoring input and store a required normalized mode in the canonical Message reconstructed from its committed source.
- Use the design default of 256 pending Message identities per recipient as an injected scheduler limit so #43 can later provide a policy snapshot without changing scheduler semantics.
- Keep Creation Requests fixed Deferred; issue #38 does not add a delivery-mode field to `agent_spawn`.
- Use the awaited identity-bound `turn_end` extension event. A plain session subscription cannot establish the required pre-next-context ordering.

## Surprises and discoveries

- Pi 0.83.0 awaits extension `turn_end` handlers after all tool results and before polling its Steer queue, which is the exact required safe boundary.
- Pi's `sendCustomMessage(..., { deliverAs: "steer" })` queues immediately while streaming and becomes model-visible only when the loop drains that queue after `turn_end`.
- A package dry run exposed obsolete ignored build artifacts from the generalized module names. Removing those generated files prevents retired Deferred-only modules from shipping.

## Outcomes and retrospective

Implemented authored Deferred/Steer Messages, transcript-proven ordered batches, bounded cross-mode scheduling, safe-boundary Steer priority, native rendering, and explicit capacity receipts. Creation Requests remain fixed Deferred under their canonical `agent_spawn` contract. Deterministic integration coverage proves reverse tool completion, post-freeze admission, batching, coalescing, confirmation loss, and dormant Run behavior.

Final validation passed the full 53-test suite, typecheck, build, package dry run, production audit, and diff checks. Independent Standards and Spec reviews found no remaining blockers.
