# Coordination delivery and observation recovery

## Goal and intention
Keep admitted Requests deliverable across normal recipient settlement and optional context preparation; bound moderation for one continuous blocked Message; eliminate synchronous observation stack overflow; require current primary evidence before missing-result/crash reports.

## Scope and constraints
Project checkout only; do not deploy/reload installed extension. Preserve unrelated dirty package.json and tests/run-test-suite.test.ts, tests/support/run-test-suite.ts, tests/support/test-process-supervisor.ts. No #95 UI changes, full suite, legacy paths or security enforcement.

## Work plan
1. Read protocol/Pi lifecycle docs and inspect provided incident evidence.
2. Reproduce pending Request lifecycle, fix and validate focused runtime/delivery contracts.
3. Reproduce repeated Moderator handling under nudge/settlement; fix continuous-condition tracking.
4. Reproduce real observation recursion pattern, distinguish workflow growth from reentrancy; fix and validate coherent scope/restoration.
5. Strengthen Moderator primary-evidence guidance, document supported contracts.
6. Run affected tests/typecheck, review diff, commit task-owned files and move plan to done.

## Validation
Existing runtime-host/delivery, moderation coordinator, transcript/agent-record boundaries and guidance contracts (seam confirmation requested). Test first one vertical slice at a time. Record actual red/green commands and causal limits below.

## Progress
- Read CONTEXT.md, plan instructions, diagnosing-bugs and TDD skills, transcript-consumption docs and installed Pi README.
- Found additional pre-existing package.json modification; excluding it.
- Requested seam confirmation from requester.

## Evidence
Incident 2026-09-09: blocked review kAwu0w1dLmTOD5_CDQwyXxw6A8D-3b-5lGQedffTlQ8 and benchmark ZZQwEHpc5qdUaImm0gaPyWz8PA-AMg9NcMt3_mfm8xo; six Moderator inputs for same review after worker settlement. Owner diagnostic entry 356dbdd7 reports alternating withObservation/observeNext overflow. Need direct verification, not stack-only inference.

## Checkpoint: continuous Delivery failure
- Approved test seams confirmed by requester.
- During user pause unrelated changes were committed; current baseline bea0fd5 (only task plan initially dirty on resume).
- Direct incident read verifies call 007a580e and successful matching result 0f9aaa76 (80 ms later), and actual terminal entry 98a9f2ac. There are only 11 child-directory entries, so agent-count-only overflow is not an incident explanation.
- Existing preparation matrix passes baseline (12/12, ~0.7s); it starts on an idle recipient, not prior delivery settlement. Need reproduce remaining lifecycle pattern before fixing.
- RED: node --test --test-name-pattern='nudging a failed Delivery' tests/operational-incidents.test.ts reports 2 Moderators versus 1 after terminate -> ordinary nudge -> settlement with original Request unproven.
- Cause: #deliveryWaitIsLegitimate checks recipient active work before the known-failed flag, suppressing failure observation and releasing the handling key. Move known failure ahead of ordinary work/foreground checks while retaining explicit Human/selection/Hold/capacity exclusions.
- Initial combined validation exposed a fixture race: model responses were replaced before the first Moderator completed. The regression now waits for its committed assistant result before issuing the nudge. Three isolated repetitions pass (~2.6s each); selection recurrence and terminated-leaf observation also pass. No automatic retry added.

## Checkpoint: report evidence guidance
- RED: `node --test --test-name-pattern='Moderator report guidance' tests/extension-conformance.test.ts` fails because registered report guidance lacks exact call/result and current tail verification.
- GREEN: the same contract plus publication-error rendering test pass (2/2, ~0.5s).
- Moderator report guidance now requires current status/path, exact toolCallId/toolResult matching across the physical transcript, actual tail ID/timestamp, and explicit uncertainty for unavailable evidence. It distinguishes historical inspectedThrough/excerpts from the current tail and missing results from proven crashes. No enforcement or schema added.
- A separate read-only delivery investigator found no new confirmed defect: all 12 preparation matrix tests pass, and the scheduler's "Recipient Run ended before Delivery proof" is a secondary failure diagnostic, not the originating fault. Tool-driven rollover remains outside that fixture.

## Checkpoint: observation stack safety
- Requester accepted the bounded stack-safety correction while requiring an explicit incident causal limit.
- RED: `node --test tests/agent-transcript-observation.test.ts` reproduces RangeError with 20,000 observations; nested/duplicate scope, callback failure, reader failure and fresh-read behavior pass on the original code.
- GREEN: observation, AgentTranscript, and workflow-resume tests pass (36/36, ~0.5s).
- Replaced per-Agent recursive callbacks with one iterative synchronous scope, with reverse-order restoration in finally; the coordination wrapper captures its roster before inspection. Removed the obsolete single-observation entry path.
- This proves roster-independent stack depth, not the cause of the 11-child incident. No synchronous reconciliation reentrancy or live-Map growth was established in the reviewed paths; retained transcript readers and request graph evaluation do not call the scope recursively.
- Typecheck currently reports unrelated `tests/workflow-resume.test.ts:428` (outstandingRequests does not exist); no task-file diagnostics.

## Validation correction: precise failed-Delivery regression
- Re-running the stabilized nudge integration fixture against pre-fix scheduler showed it also passes. The earlier RED was confounded by its model-response/Moderator completion race; it is not causal proof and that low-value fixture has been removed.
- Replaced it with `tests/failed-delivery-observation.test.ts` at the scheduler's supported blocked-Delivery observation seam. It records a real scheduling failure, changes recipient state from dormant to unrelated active work and settled, and checks that the same blocked Message remains continuously observable. Explicit selection still suspends it and Delivery proof clears it.
- Confirmed RED against `e6a976b^` scheduler in a disposable checkout: active work incorrectly returns [] instead of the existing scheduling_failure. GREEN on current scheduler (~0.37s).
- This is precise proof of the suppression/reappearance defect that releases moderation keys. Existing integration selection/recurrence coverage passes, but the live incident's exact nudge lifecycle is not replayed by this unit seam.
