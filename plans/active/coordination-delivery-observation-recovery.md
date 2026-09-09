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
