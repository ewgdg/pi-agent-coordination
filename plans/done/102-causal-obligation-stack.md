# Causal Request trees and focused obligations (#102)

## Goal and scope
Allow descendant Requests to preempt a cooperatively waiting obligation, with one foreground frame and a suspended stack. Keep source-derived canonical IDs and accept unique incoming Request suffixes for `answer.requestId`, following the final #101 contract. No unrestricted interruption or multitasking.

## Durable model and decisions
Use retained, bootstrap-scoped transcript facts as the event log: Request Delivery pushes focus; successful correlated Answer result or Cancellation Delivery removes exactly that frame. The Request author's focus immediately before its canonical source is its immutable parent. This persists ancestry, frame ownership, and stack ordering without a second mutable store; compaction does not discard physical protocol evidence. All source-time projections are bounded so later appends cannot retarget prior calls.

Cancellation remains one hop. Remove the named foreground or suspended frame, retain nested obligations, and transfer outstanding outgoing dependencies to the nearest surviving enclosing frame (or independent work). Answer resolution also leaves any unjoined outgoing work owned by that enclosing frame. Never automatically cancel another Agent's Requests. Answers delivered to a suspended frame settle only its dependencies; the nested foreground does not inherit them. A resumed frame receives current dependency context on a later continuation.

Eligibility is checked in recipient admission order among candidates that can run: no foreground, or descendant of a waiting foreground. Unrelated/sibling Requests stay queued, and descendants may pass them. A committed Answer must end its execution turn before resumed focus is presented. Active generation is never interrupted to deliver a descendant.

## Public test seams and work plan
Established seams: RequestEvidence over retained native transcripts, WorkflowCoordinator participant operations, registered Pi tools and real session lifecycle. These are the existing implementation workflow's public seams.
1. Add a failing focused stack/ancestry test and implement reconstruction plus explicit Answer targeting.
2. Add queue/preemption and frame-wait tests, implement eligibility and scoped joins.
3. Cover cancellation, reopen/compaction, stale targeting, and real Answer turn transition.
4. Repair remaining deadlock detection and update protocol/tool documentation.
5. Independent Standards and Spec reviews against 42faeb4; fix findings, run affected tests/typecheck/package/audit/diff checks, commit task changes. Avoid the full integration suite per project guidance.

## Progress
- Read #102, final prerequisite #101, current contracts and implementation. Created isolated worktree at `.worktrees/causal-obligation-stack` from 42faeb4.

## Validation
Record red/green evidence and final check outcomes here as slices complete.

## Completed slices and evidence
- Explicit Answer targeting, source-time Request ancestry, foreground/suspended reconstruction, scoped waits, exact-frame cancellation, and descendant FIFO eligibility are implemented. Registered process tests cover one/two outgoing Requests, unrelated-head bypass, sibling serialization, cancellation cleanup, transition receipts, standalone Answer batches, and stale/replayed Answers.
- Recovery reconstructs canonical focus even when requester-side Answer Delivery precedes the responder's result. Startup writes a local focus reconciliation before any further model authorship; the next Request inherits the restored parent and survives another native reopen. Core focus projections initialize at Identity bootstrap within bounded transcript catch-up.
- A live sibling test initially timed out: the first preemption reservation remained until the original Pi prompt Promise ended. Releasing the reservation on committed Delivery proof allows the resumed parent to accept its next eligible sibling. Its dispatch Promise remains observed for failures.
- Genuine deadlock tests now use two independent Creation Request roots with a startup barrier and blocked cross-Requests. Nested clarification cycles correctly no longer serve as deadlock fixtures. Tests retain active-work, Human attention, selection, and Hold exclusions, plus normalized two-Agent/two-Request Moderator proof.
- Documentation and tool guidance now describe explicit Answer references, one-hop cancellation, scoped dependencies, terminal Answer execution, and later focus continuation. The final #101 suffix contract is used; no identity allocator is introduced.

## Review and final validation
- Independent Standards: three findings fixed (eager projection initialization, eligibility naming, shared dependency ownership). Follow-up review also accepted the proof-based reservation release; no remaining findings.
- Independent Spec: missing-local-result recovery fixed and independently checked (8/8 stack/recovery tests); no remaining findings.
- Final focused stack/process/tool-schema tests: 31 passed. Targeted changed lifecycle/renderer/deadlock tests passed. Final five updated moderation/blocked-cycle tests passed.
- Broad selected Request/recovery/preemption/moderation regression: 82/90 initially passed. Five task-related failures were corrected and re-run successfully; three failures reproduce unchanged at base 42faeb4 (Moderator tool list includes powershell, invalid thinking-level fixture, post-mortem view assertion).
- Fast suite had seven failures: the Answer schema assertion was updated and passed. Six remaining failures reproduce at base 42faeb4 (control schema selector fixture, four operational reconciliation fixtures, parked-delivery host mock).
- Additional selected spawn/message/parking checks: eight passed; two spawn failures reproduce at base 42faeb4 (powershell tool list and forged Creation Request fixture). These eleven confirmed baseline failures are outside #102; no full process suite was run, per project guidance.
- `npm run typecheck`, `npm pack --dry-run`, `npm audit --omit=dev` (zero vulnerabilities), and `git diff --check` passed. No build script exists. Validation logs are retained under the agent artifact output for this project/date/issue.

## Outcome
Implemented in the isolated `codex/causal-obligation-stack` worktree. All task-owned code, documentation, and tests are complete and included in the implementation commit. No push is authorized.
