# Workflow progress parking (#120)

## Goal and intention

Keep the Owner's native Pi run open only while the workflow can make autonomous progress. Unresolved Requests are durable relationships, not proof of running work. Release an already parked Owner when human input or unrecoverable stalling is the only remaining path, without waiting for another Owner message.

## Scope and constraints

Implement the workflow-progress predicate, its change notification, and Owner parking entry/release. Include nested ordinary Agents, delivery handoffs and actual Moderator recovery. Preserve native retry, compaction, continuation, input, interruption and shutdown. No managed Herdr changes, no later-failure author notifications (#119), no live-session mutation.

## Work plan

1. Add an actual AgentSession regression: a parked Owner must settle when its only child reaches Human Request.
2. Derive autonomous progress from existing exact Run, scheduling and recovery state behind the coordinator seam; subscribe the parker to loss of progress.
3. Cover continued independent work, dependency chains, terminal Runs, delivery handoffs, and cleanup/races with focused tests.
4. Update supported behavior docs, typecheck, focused validation, and commit.

## Validation

Run only Owner parking, workflow-progress and adjacent scheduler/operational tests. Capture red/green outcomes. Test native `isIdle` and `agent_settled`, not only internal flags. Existing Pi integration exposes generic settlement, not a distinct blocked-versus-completed event; coordination attention remains the semantic surface.

## Progress

- Initial non-admission is already fixed by `0d89c9d`; current work addresses retained admitted dependencies and parking release.
- Existing parker wakes only for queues or cancellation; activity observers already exist in the coordinator.
- Red regression: `node --import ./tests/support/pi-test-environment.ts --test --test-name-pattern='Owner settles when its only' tests/owner-settlement-parking.test.ts` failed in 3.6s: Owner stayed active after its only child required human input. The same actual-AgentSession case passes after the predicate and notification change (now named `Human input releases passive parking ... explicit Wait: false`).
- Implemented whole-Workflow Run progress, eligible/dispatched Delivery progress, and bounded actual recovery inspection; the parker observes progress loss and coalesces same-event lifecycle handoffs before release.
- Actual Pi cases pass for sole Human Request, nested dependency chains with both independent-work completion orders, terminal failure → Moderator recovery → Human Request, termination plus later dormant dependency, ordinary work without Requests, Answer/compaction continuation, and native custom input.

## Decisions and remaining scope

- Parent explicitly kept this change bounded to passive settlement. An executing Owner `agent_wait` is a native tool call, not a parking boundary. Its preemption/result semantics remain unchanged and a paired regression documents that distinction. Issue #120 must remain open for the full native attention contract; commit references it without closing it.
- Native `agent_settled` is readiness, not a blocked-versus-done event. Coordination `DECIDE`/`ATTENTION` remains the semantic surface. No Herdr-specific events or managed integration edits.
- Pending recovery only counts while actual inspection/preparation is in flight, and stops counting at the existing moderation deadline. Dormant identity/retention and waiting dependency edges alone never count.

## Validation outcome

- Full focused `tests/owner-settlement-parking.test.ts`: 10 passed (~8.7s), including the explicit-Wait limitation and native Answer/compaction/input behavior.
- Parker, parked-Delivery scheduler and failed-Delivery observation files: 26 passed (~0.4s), including progress-loss entry race, same-event handoff, proof vs prompt completion, failed scheduling, Holds/human/dependency wait, and Delivery deadline.
- Four selected operational tests passed (~4.1s): failed bootstrap, Delivery deadline, hung inspection, hung replacement preparation. Added workflow-progress assertions prove inspection/preparation stop counting at their existing deadline.
- Final focused Moderator recovery tests, typecheck and `git diff --check` passed. No full integration suite, live-session reload, or Herdr mutation.

## Outcome

Passive parking now follows existing autonomous execution/scheduling/recovery rather than durable Request retention, and releases without input when that progress stops. The first minimal actual-Pi regression went red before implementation and green afterward. No protocol identity, Wait result, or retry behavior changed. Native attention during an executing Owner Wait remains explicitly unresolved under #120; #119 is separate and untouched.
