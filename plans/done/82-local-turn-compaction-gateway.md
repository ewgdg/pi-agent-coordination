# Local turn compaction gateway

## Goal

Defer a child Agent's automatic post-run threshold compaction when no continuation is queued, then compact only when the same session next admits model-visible work. Preserve Pi's native manual and overflow behavior, exact Run termination, Delivery evidence, custom-message fields, and process-isolated Runtime lifecycle.

This plan implements the local-protocol option from [issue #82](https://github.com/ewgdg/pi-agent-coordination/issues/82). It does not wait for an upstream Pi turn-admission interface.

## Intention

Put one deep **Turn Compaction Gateway** module inside the child process at the seam where all model-starting input reaches the exact `AgentSession`.

The gateway owns the short interval from turn admission through preparation and Pi's commit boundary. It never owns the model cycle. It serializes native prompts, Owner prompts, idle custom Deliveries, queue clearing, and interruption only while they can change which input commits next.

Deferral is stateless:

```text
post-run threshold request with no queued continuation
  → cancel this compaction
  → release the Run and Runtime normally

next native or Owner user prompt
  → Pi recomputes threshold in prompt preflight
  → Pi compacts if still needed
  → Pi commits the triggering user message

next idle custom Delivery
  → gateway recomputes threshold from current public state
  → gateway calls public compact() if still needed
  → gateway commits the exact custom Delivery
```

No durable “compaction pending” fact, Owner-side retention reason, or new Control event is needed. A fresh Runtime can recompute from the same transcript before its next idle custom Delivery.

## Confirmed Pi behavior

The implementation may rely on these public Pi 0.84 interfaces, guarded by the existing host-shape admission:

- Awaited `session_before_compact` exposes `reason: "manual" | "threshold" | "overflow"` and accepts `{ cancel: true }`.
- `AgentSession.prompt()` performs input handling, threshold/overflow preflight, `before_agent_start`, and then starts the Agent.
- `AgentSession.sendUserMessage()` delegates to `prompt()`.
- Idle `AgentSession.sendCustomMessage(..., { triggerTurn: true })` bypasses prompt compaction preflight.
- `AgentSession.getContextUsage()`, `settingsManager.getCompactionSettings()`, exported `shouldCompact()`, and public `compact()` are sufficient to recompute and perform threshold preparation for an idle custom Delivery.
- `AgentSession.agent.hasQueuedMessages()` sees raw user and custom Steer/Follow-up queues. `ExtensionContext.hasPendingMessages()` and `AgentSession.pendingMessageCount` do not.
- `agent_start` is awaited before the triggering user or custom message is emitted and persisted.
- `abortCompaction()` cancels manual and automatic compaction.
- Public `compact()` reports `reason: "manual"`; this is accepted for a replayed deferred threshold compaction.

No Pi dependency bump is required. Pi issue `earendil-works/pi#8349` remains relevant to ordinary `ExtensionContext` users but does not block the captured public `AgentSessionRuntime` used here.

## Scope and constraints

### Required behavior

- Cancel only `reason === "threshold"` compaction when no raw Agent continuation is queued and no turn is currently preparing.
- Never cancel or replace manual compaction.
- Never cancel or replace overflow recovery.
- Let queued user or custom Steer/Follow-up work keep Pi's native post-run compaction.
- Before every idle custom trigger-turn Delivery, recompute usage, context window, and compaction settings from the current Runtime. Compact only if the current threshold still applies.
- Commit the triggering input only after preparation completes.
- Preserve custom Delivery `customType`, content, details, display behavior, transcript order, and exact transcript-commit proof.
- Keep `triggerTurn: false` custom messages independent of unrelated model work and compaction.
- Keep queue clearing and interruption ordered against the short preparation/commit interval without holding the gateway for the model cycle.
- Let exact Run termination fence native input still in inherited input handling or compaction.
- Invalidate every active or queued gateway operation on Runtime disposal, session replacement, and binding-generation replacement.
- Preserve current Runtime release. A cancelled threshold compaction must not retain an otherwise releasable Run or Runtime.

### Explicit decisions

- Do not measure unused compaction frequency. The product decision to implement has been made.
- Do not persist a deferred-compaction marker.
- Do not add a Control protocol event solely for deferred state.
- Do not use private Pi methods, private queue fields, or `InteractiveMode` compaction queues.
- Do not infer queued custom work from `pendingMessageCount`; use `session.agent.hasQueuedMessages()`.
- Do not use global `agent_settled` as Delivery commitment proof.
- Do not preserve a compatibility path around the gateway.
- Keep the current handled-input behavior, including an Owner-issued returning Delivery when the Owner consumes native input. Native input enters the gateway only after the Owner returns `continue`, so that returning Delivery never waits behind a reservation held by its source input.

### Admission ordering

A native submission is not admitted to Pi's next-turn lane merely because terminal bytes were observed. Its ordering point is the successful Owner disposition:

```text
native input
  → inherited input handlers
  → Owner disposition
      submitted/discarded: original input does not enter the gateway
      continue: acquire gateway admission, then let Pi continue
```

This placement removes the returning-Delivery cycle without adding a bypass capability. An Owner Delivery that commits while native input is still awaiting disposition wins admission legitimately. Exact termination fencing remains tied to the terminal submission sequence and the later `runtime.executionBegin` check.

## Target module and interface

Add a child-local module under `src/process-runtime/`, named for turn preparation rather than generic locking. Its external interface should remain small and intention-revealing. The implementation may use a serial lane and exact operation records internally, but callers should only express these intentions:

1. evaluate one `session_before_compact` event;
2. admit and track one native prompt after `continue`;
3. run one Owner-issued prompt or Delivery through preparation and commit admission;
4. order queue clearing or interruption against current admission;
5. invalidate the exact Runtime generation.

The module hides:

- FIFO scheduling and operation identities;
- whether preparation is native Pi preflight or explicit custom-Delivery compaction;
- cancellation and compaction abortion;
- release at `agent_start`, handled/rejected prompt completion, queue insertion, or non-turn transcript commitment;
- Runtime-generation fencing;
- the distinction between Delivery dispatch completion and transcript proof.

The interface must not expose locks, Promises representing the model cycle, Pi private state, or Control request IDs.

## Behavioral model

### Threshold hook

At `session_before_compact`:

| Condition | Result |
| --- | --- |
| `reason` is `manual` | allow Pi |
| `reason` is `overflow` | allow Pi |
| threshold and `session.agent.hasQueuedMessages()` | allow Pi |
| threshold and a turn is preparing | allow Pi |
| threshold, no queued continuation, no preparation | cancel |

A queued gateway operation that has not begun need not prevent cancellation. That operation recomputes when it enters the lane.

### Input classes

| Input | Gateway behavior |
| --- | --- |
| Idle native input with Owner disposition `continue` | admit after disposition; let `prompt()` perform native preparation; release when Pi crosses `agent_start` or prompt preflight terminates |
| Native input consumed as Human Answer, resumption Delivery, Dormant Delivery, or discarded input | original input takes no gateway reservation; the resulting Delivery uses its own admission |
| Owner `run.prompt` | admit; let `prompt()` perform native preparation; resolve existing `preflightResult` truthfully; release before the model cycle |
| Idle trigger-turn custom Delivery | admit; recompute threshold; call public `compact()` if needed; dispatch the untouched Delivery; release at Pi turn start while transcript proof continues independently |
| Custom Steer/Follow-up while streaming | order queue insertion only; do not compact; release immediately after queue admission |
| `triggerTurn: false` custom Delivery | do not compact or abort an unrelated Run; serialize only the exact transcript commit needed for proof |
| `queue.clear` | order after already admitted queue insertion/commit work; clear exactly the current Run's queues |
| `run.interrupt` / termination | fence the exact Run immediately, cancel matching gateway preparation, abort only gateway-owned compaction, then perform native interruption ordering |

### Commitment and release

The gateway's release boundary is not Agent settlement:

- Trigger-turn prompt or Delivery: awaited `agent_start`, or preflight failure/cancellation before it.
- Streaming Delivery: successful queue insertion.
- Non-trigger custom Delivery: exact message commitment.
- Queue mutation: completion of that mutation.

`observeDeliveryCommit()` remains authoritative for a Delivery's transcript proof. Gateway release must not cause `message.deliver` to report commitment early.

## Test seams

Approval of this plan confirms these behavioral test seams for TDD:

1. **Concrete Pi host seam** in `tests/pi-host-behavior-conformance.test.ts`: public compaction events, raw Agent queue visibility, native prompt ordering, and transcript branch behavior.
2. **Child Control seam** in `tests/pi-child-process-runtime.test.ts`: `run.prompt`, `message.deliver`, `queue.clear`, `run.interrupt`, custom fields, exact commit proof, and cancellation.
3. **Selected child presentation and supervision seam** in `tests/agent-view.test.ts` with the process probe fixture: native input, Dormant/handled input, retained Runtime termination, compaction, and later successor work.
4. **Exact input lifecycle seam** in `tests/child-runtime-interactive-mode.test.ts` and `tests/native-input-submission-identity.test.ts`: one terminal submission, one prompt, handled/rejected paths, and binding invalidation.
5. **Host-shape seam** in `tests/host-shape.test.ts`: every new public Pi member used by the gateway.

Tests should assert transcript order, visible receipts, Run phase, process retention/disposal, and absence of late commitment. They should not assert internal lane state or private helper calls.

## Work plan

Implement in vertical red-to-green slices. Do not write all tests before all implementation.

### Milestone 1: lock public Pi conformance

1. Add a focused conformance test proving `session_before_compact` reports threshold, can cancel it, and leaves manual and overflow behavior native.
2. Add a queued-custom continuation test where `ctx.hasPendingMessages()` is false but `session.agent.hasQueuedMessages()` is true; prove post-run threshold compaction is not cancelled.
3. Add host-shape checks for the exact public members used by the gateway: `AgentSession.agent`, `Agent.hasQueuedMessages`, `getContextUsage`, `settingsManager.getCompactionSettings`, `compact`, and `abortCompaction`.
4. Keep the conformance additions small enough to diagnose a future Pi incompatibility without running process integration.

Checkpoint: tests express the upstream behavior the local design depends on; no production behavior changes yet.

### Milestone 2: defer unused post-run threshold compaction

1. Add the Turn Compaction Gateway module with only threshold-event evaluation and Runtime-generation disposal.
2. Register its `session_before_compact` handler in `child-runtime-bridge.ts` against the exact current binding.
3. Use `session.agent.hasQueuedMessages()` at the awaited threshold decision.
4. Cancel only unused threshold compaction. Keep no deferred marker and add no Runtime retention.
5. Add a process-backed test proving a terminal child Run reaches release without appending an otherwise unused threshold compaction.
6. Add a queued custom continuation test proving Pi compacts before continuing rather than deferring.

Checkpoint: terminal threshold work disappears, while queued continuation, manual, and overflow behavior remain unchanged.

### Milestone 3: prepare the next idle custom Delivery

1. Add gateway admission around `handleOwnerRequest("message.deliver")` without changing `observeDeliveryCommit()`.
2. For an idle trigger-turn Delivery, read current context usage and current compaction settings inside the admitted operation. Use public `shouldCompact()` and call public `session.compact()` only when the current threshold applies.
3. Re-check cancellation and exact Run identity after every preparation `await` and immediately before Delivery dispatch.
4. Preserve the Delivery object byte-for-byte through `dispatchDelivery` so `customType`, content, details, display, and delivery mode are unchanged.
5. For a streaming Delivery, admit only queue insertion and release before transcript settlement.
6. For `triggerTurn: false`, skip compaction and preserve unrelated active work.
7. Add process-backed red/green tests for exact transcript order, one compaction, exact custom fields, commitment proof, no late Delivery after cancellation, and no unrelated abort.

Checkpoint: the next idle custom Delivery compacts first when currently required and otherwise commits directly.

### Milestone 4: admit native and Owner prompts without re-entry deadlock

1. Extend the existing input delegate so only Owner disposition `continue` acquires a native gateway admission. `submitted` and `discarded` finish without one.
2. Bind the admission to the exact input submission and current child binding generation.
3. Keep the admission active while Pi runs the remaining prompt preflight and compaction after the final participant input handler returns, then release when Pi crosses the exact turn-start boundary or the prompt completes without a turn.
4. Route `handleOwnerRequest("run.prompt")` through the same gateway while preserving its existing `preflightResult` acceptance contract and exact Run identity.
5. Add a regression proving a handled Dormant or resumption input can receive its returning Delivery and complete without deadlock.
6. Add a regression proving a `continue` input compacts before its user message and admits exactly one successor Run.
7. Add failure cases for inherited input rejection, command handling with no turn, authentication/preflight failure, and duplicate completion.

Checkpoint: every idle user prompt is prepared through Pi's native path, and no native input holds admission while waiting for an Owner-issued returning Delivery.

### Milestone 5: order cancellation, clearing, and Runtime invalidation

1. Route `queue.clear` through the gateway's short ordering interface.
2. Make `run.interrupt` synchronously fence the matching active preparation before awaiting the admission lane. Abort only a compaction owned by that preparation.
3. Preserve existing projection submission fencing and final `runtime.executionBegin(submissionSequence)` admission checks.
4. Ensure a cancelled custom Delivery cannot commit after compaction returns, even if its original Control request remains in flight.
5. Invalidate pending operations when `createChildRuntimeBinding().dispose()` runs, when the retained session reload binds a new generation, when Control closes, and when the Runtime shuts down.
6. Add process-backed races for interrupt during native pre-prompt compaction, interrupt during custom-Delivery compaction, clear concurrent with queued Steer/Follow-up Delivery, Control cancellation, `/reload`, and Runtime replacement.
7. Prove stale completion from generation A cannot release, commit, or interrupt generation B.

Checkpoint: termination, interruption, clear, cancellation, and replacement have one observable order against preparation and commit.

### Milestone 6: simplify and document the final design

1. Remove superseded queue-intention or compaction-retention logic only where the gateway now owns the same invariant. Do not combine unrelated cleanup.
2. Update `CONTEXT.md` with the final domain term if the implementation introduces one that callers or future plans must use.
3. Update `docs/run-supervision.md`, `docs/agent-messaging.md`, and child Runtime documentation with the short admission interval, threshold deferral, custom Delivery preparation, and termination behavior.
4. Correct `docs/learning/turn-admission-concurrency/lessons/0001-the-returning-delivery-deadlock.html`: the deadlock belongs to the discarded design that acquired admission before Owner disposition, not to every native input flow.
5. Record why raw `Agent.hasQueuedMessages()` is required and why no deferred marker or Runtime retention exists.

Checkpoint: documentation states the implemented design directly and does not preserve the discarded capability/bypass protocol as product behavior.

## Validation

Run targeted tests after each vertical slice. Keep each automated test under the project's normal fast-failure expectations.

Targeted gates:

```text
node --test tests/pi-host-behavior-conformance.test.ts
node --test tests/host-shape.test.ts
node --test tests/child-runtime-interactive-mode.test.ts
node --test tests/native-input-submission-identity.test.ts
node --test tests/pi-child-hosted-runtime.test.ts
node --test tests/pi-child-process-runtime.test.ts
node --test tests/run-projection-lifecycle.test.ts
node --test tests/agent-view.test.ts
npm run typecheck
```

Final gates:

```text
npm run test:fast
npm run test:process
npm run test:conformance
npm run typecheck
git diff --check
```

Do not run the full process or conformance suites until the targeted gateway, Delivery, native-input, and termination tests pass.

## Progress

- [x] Confirmed local implementation is preferred over waiting for an upstream Pi admission interface.
- [x] Confirmed threshold identification and cancellation are public through `session_before_compact`.
- [x] Confirmed raw queued custom continuations are visible through public `session.agent.hasQueuedMessages()`.
- [x] Accepted public `compact()` reporting replayed work as `reason: "manual"`.
- [x] Removed measurement as an implementation prerequisite by explicit product decision.
- [x] Chosen stateless deferral and post-disposition native admission; no durable marker, Runtime retention, or returning-Delivery bypass capability.
- [x] Confirmed the proposed plan and behavioral test seams through the implementation request.
- [x] Moved the plan to `plans/active/` before implementation.
- [x] Implemented threshold deferral, prompt and Delivery preparation, native admission, cancellation, queue ordering, and Runtime-generation disposal.
- [x] Added process-backed coverage for queued continuations, Owner and native prompts, custom and user Deliveries, non-turn custom commitment, compaction cancellation, interruption, and delayed input preflight.
- [x] Updated domain, Run supervision, and Agent messaging documentation.
- [x] Passed fast tests, conformance, typecheck, diff checks, focused process Runtime tests, the complete Agent-view test file, and selected reload/hosted Runtime tests.
- [x] Ran the complete process gate; its sole repeatable failure is the pre-existing third-party Agent Wait preemption assertion, reproduced unchanged on clean `HEAD`.

## Surprises and discoveries

- Process isolation does not itself require native text to return through the Owner. The current returning Delivery exists only when the Owner consumes the original native input, such as Dormant activation or isolated resumption.
- Re-entrant IPC works today because no admission reservation blocks the returning Delivery. The discarded prototype deadlocked only because native input held a shared reservation while awaiting the Owner.
- The simplest local fix is not a bypass capability. Admit native input only after the Owner returns `continue`; handled input never owns that reservation.
- `runtime.executionBegin(submissionSequence)` already provides the final exact native-input admission after prompt compaction and before transcript commitment.
- Pi's visible pending-message state omits custom Agent queues, but the captured public `AgentSession` exposes `agent.hasQueuedMessages()`, which is the exact boolean needed here.
- A deferred marker is unnecessary. Native prompts already recompute, and idle custom Deliveries can recompute on every gateway admission. This also lets an unused child Runtime release immediately.
- Releasing native admission at prompt preflight is too early: an Owner Delivery can claim Run identity while native `agent_start` awaits Owner admission. Native identity must be assigned synchronously in the first child `agent_start` handler before releasing the gateway.
- Prompt cancellation can be made final through Pi's public `preflightResult`: throwing from that callback prevents `_runAgentPrompt` after an async inherited preflight finishes.
- Dormant input queued behind manual compaction exposed a real returning-Delivery deadlock until native admission was released before the later Owner execution-admission request.
- Binding disposal must retire an idle preflight-owned Run immediately; otherwise a retained `/reload` binding inherits a stale busy Run ID.

## Decisions

- Implement one child-local deep module rather than distribute compaction checks across input and Delivery callers.
- Keep Workflow authority and exact Run fencing in the Owner; keep Pi turn preparation and commitment ordering in the child that owns the session.
- Treat successful Owner disposition as the native input's gateway-ordering point.
- Keep transcript evidence as the only durable authority. Compaction deferral remains volatile policy and is always recomputed.
- Preserve exact Delivery transcript proof outside the short gateway reservation.
- Prefer current public Pi types and methods over a dependency bump or upstream patch.

## Outcomes and retrospective

The gateway remained one child-local module. Stateless recomputation covered fresh Runtime and reload paths without adding durable state, Control events, or Runtime retention. Existing Runtime compaction activity continues to retain manual compaction only while Pi is actually compacting.

The implementation required one protocol widening: custom Runtime Deliveries now preserve an explicit boolean `triggerTurn`, allowing transcript-only custom commitment without model work. Exact transcript proof remains outside gateway admission.

The difficult races were not threshold calculation. They were admission release and cancellation: native Run identity must be fixed before the Owner admission await, Owner/user prompt cancellation must throw at Pi's public preflight callback, and disposed bindings must reject observers and retire idle preflight-owned Run state. Process tests now exercise these boundaries.

Validation found one unrelated existing process-suite failure in the third-party Agent Wait preemption test. The same assertion fails on a clean `HEAD` worktree, so it was not changed as part of issue #82.
