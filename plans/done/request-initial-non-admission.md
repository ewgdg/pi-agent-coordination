# Definitive Request non-admission

## Goal and scope
A definitively unadmitted initial Agent Request creates no outstanding dependency and cannot become retryable after reconstruction. Preserve unknown admission, admitted Requests, Creation Requests, and Answer/Cancellation delivery failures. Do not change Owner parking or live session data.

## Plan and validation
1. Reproduce `not_sent: target_unavailable` without recipient Run/Delivery, checking requester retention, reconstructed evidence, and retry.
2. Interpret validated initial Request non-admission as non-creation and remove provisional retention on definitive admission failure.
3. Adjust supported documentation and tests that intentionally need uncertain or already-admitted Requests.
4. Run targeted Request/protocol tests and typecheck; commit task-owned changes.

## Progress
- Inspected CONTEXT, messaging contracts, continuation ADR, author-result inspection, Request evidence and delivery admission. Initial author results currently make every validated `not_sent` canonical; Creation Requests separately become canonical at child Identity commitment.

## Decisions
- Keep the existing receipt shape and source-derived ID for correlation; it is not a retryable Request after definitive initial non-admission.
- Limit changed authoring semantics to ordinary Agent Requests. Ordinary Messages, Answers, Cancellations and Spawn retain existing semantics.

## Completed checkpoints
- Added the admission-rejection regression first: before the implementation, requester retention was 2 instead of 1 with no recipient Run. Added a real renamed-working-directory reproduction and verified it against original production code: retention was 3 instead of 2. Both now pass, including immediate retention, committed-result reconciliation, retry rejection, explicit Wait exclusion, and Cancellation rejection.
- Validated initial `not_sent` becomes `not_created` only for ordinary Agent Requests. Author-result schema validation still precedes that decision; contradictory Delivery is rejected. Request lookup rejects non-created sources, and initial admission failure removes provisional requester retention. Unknown and original admitted author results remain canonical regardless of later retry failure.
- Reconstruction matrix covers target-unavailable, shutdown and capacity rejection, unknown confirmation, admitted work, and later failed retry results. Separate coverage preserves Spawn commitment and contradictory Delivery detection.
- Existing tests needing undelivered canonical Requests now use explicit uncertain transcript evidence, rather than definitive initial rejection. Runtime retention coverage uses genuinely admitted, confirmation-lost scheduling.
- Reviewed receipt identities and rendering: no shape change is required; the existing error rendering remains accurate. Updated model tool guidance, messaging documentation, and CONTEXT narrowly.

## Validation and outcomes
- Final changed/adjacent Request integration selection: 12 passed (including continuation preparation, Wait, Cancellation, uncertain retry, and Creation Request retry/Answer).
- Message Request/capacity/confirmation/retry selection: 8 passed.
- Request evidence, resolution, renderer, Wait recovery, and participant registrar files: 97 tests passed.
- Final direct admission/renamed-cwd regressions: 2 passed. Typecheck and `git diff --check` passed.
- Ran only the Request integration file, not the full suite. Its broader run exposed two unchanged failures reproduced with original production code: selected-child primary-input preemption timed out, and the Creation Request slot test expected a Steer Request not to deliver. These are outside this fix. A startup failure passed the focused rerun; one temporary fixture-edit failure was corrected and passed the final selection.
- Test logs are retained under `~/.agents/artifacts/outputs/pi-durable-subagents/2026-09-11/request-initial-non-admission/`.
- Owner settlement parking and live workflow/session data were not modified. No migration or compatibility logic was added.
