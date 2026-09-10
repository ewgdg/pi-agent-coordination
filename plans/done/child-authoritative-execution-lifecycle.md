# Child-authoritative execution lifecycle

## Goal and intention
Let the child report actual Pi execution, independently of pending Delivery admission. A pending Delivery must not reserve the next execution identity or make an ordinary native continuation look stale.

## Scope and constraints
Child bridge, hosted adapter, their Control contract, focused regression tests, and maintained runtime documentation. No compatibility paths or unrelated fixes. Preserve exact execution-cycle protection for delayed controls and completion. Transport cycles are not durable Agent Run sequences.

## Work plan
1. Inspect Pi lifecycle and existing bridge/admission/completion contracts.
2. Add a real Pi bridge/adapter overlap regression and record failure before implementation.
3. Separate Delivery identity/admission/cancellation from child-owned lifecycle identity.
4. Check delayed settlement, dispatch completion/failure, interrupt and queue clear against successors.
5. Run targeted tests and typecheck; document the contract, commit task changes, move this plan to done.

## Validation
Use real AgentSession with faux model through createChildRuntimeBinding and PiChildHostedRuntime, gating delivery transmission/preparation and native execution deterministically. Keep individual tests bounded at five seconds. Avoid the full integration suite.

## Progress
- Read project instructions, plan guidance, run-supervision documentation, installed Pi README, compaction and extension documentation, and SDK documentation (remaining relevant cross-reference/example inspection before implementation).
- Confirmed host deliver() assigns hosted-run-N before sending message.deliver; bridge also admits that ID before optional preparation.
- Existing Delivery settlement waiters start on any lifecycle and can settle on preparation work. Correlated dispatch promises protect idle dispatch, but queued dispatch also needs real settlement.
- Exact control checks currently occur before queued intentions execute; they need revalidation at the mutation boundary.
- Requester approved removing the redundant Owner prompt method; all callers now use message.deliver.

## Discoveries
The historical original Request eventually delivered and was answered; the failing item was an obligation reminder. The supplied temporary adapter probe is mechanism evidence, not a reconstruction of the full historical ordering.

## Decisions
Actual lifecycle must originate in child Pi events. Delivery completion/failure must remain correlated to its own admission/dispatch, not mutate lifecycle state based on a host reservation.

## Implementation and regression evidence
- Added the real AgentSession + bridge + hosted-adapter overlap test before source changes. Initial command: `node --test tests/child-authoritative-lifecycle.test.ts`. It failed in 25 ms: expected work state `active`, actual `unavailable`, while native work started with Delivery transmission pending.
- Removed Owner cycle prediction and Delivery-carried runId; lifecycle remains child-authoritative with strict identity validation.
- Completion is child-correlated and waits for native idle after dispatch, including active queue acceptance. Delivery rejection no longer emits synthetic Run failure.
- Added Delivery cancellation separate from exact-cycle controls, renamed gateway admission ownership to Delivery identity, and revalidate delayed queue mutations.
- Added focused regressions for pending input-preflight interrupt, delayed queue clear/interrupt, and late dispatch rejection during a real native successor. Existing preparation matrix and settlement-continuation coverage retained.
- Removed the redundant Owner prompt protocol/public API and converted its process tests to Delivery IDs and observed child lifecycle IDs.

## Design decisions
Use Pi's existing waitForIdle contract rather than duplicating settlement tracking per Delivery in the Owner. Keep the Owner's settlement waiters only for explicit waitForIdle. Pending Delivery cancellation targets admission independently; already-dispatched cancellation may mutate native queues only for its captured child cycle. Lifecycle remains the sole execution authority.

## Validation outcomes
- Final bridge/gateway/adapter/schema/reminder/continuation group: 71/71 passed in 5.4 seconds.
- Selected real process contracts (Bridge, working-zone preparation, threshold compaction, retained attachment, coordination tools, hidden work): 6/6 passed in 12.8 seconds.
- `npm run typecheck` passed; `git diff --check` passed.
- Evidence logs: `~/.agents/artifacts/outputs/pi-agent-coordination/2026-09-10/child-authoritative-lifecycle/`.
- Implementation and regression tests committed as `6ce836e`.
- Full integration suite deliberately not run. No unresolved task gaps.

## Outcome
The child owns execution identity end to end. Pending Delivery admission, transcript commitment, cancellation, and correlated completion no longer predict or manufacture execution lifecycle. Maintained guidance is in `docs/run-supervision.md`.
