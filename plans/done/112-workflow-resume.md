# Owner-scoped Workflow resume

## Goal and intention
Implement issue #112: one explicit Owner call renews unfinished Workflow coordination after runtime restart, without replacing original Requests or replaying interrupted tools.

## Scope and constraints
Add `workflow_resume({})` through the public tool/runtime boundary. Preserve cold bootstrap as passive. Use verified durable evidence, existing scheduling/admission/capacity/Hold/Run fences, and original Message identities. Dormant responders receive runtime-generated continuation input, not an authored Message or redelivered Request. No push or PR; no full integration suite.

## Work plan
1. Read recovery contracts and installed Pi public runtime documentation; identify existing test seams.
2. Write focused failing boundary tests for restart before/after Delivery, Answer return, nested obligations, repeated/racing recovery, unavailable evidence, running Agents, capacity and Holds.
3. Implement fixed-snapshot recovery admission and dormant continuation, preserving foreground/suspended obligations and dependencies.
4. Update recovery, Owner, and messaging contracts; run focused tests and typecheck.
5. Commit source/tests and documentation at meaningful boundaries and hand off for independent review.

## Validation
Use public tool/runtime boundary tests and relevant focused existing suites, not the full integration suite. Check receipts distinguish admission from Delivery/completion and continuation from per-Message retry/Wait.

## Progress
- Read issue #112, repository instructions, plan instructions, and existing recovery contracts.
- Source and test implementation completed through bounded implementation/runtime work units; documentation completed separately.
- Public recovery test failed before implementation; second-cold-restart test exposed reused continuation proof and passed after per-activation identity correction.
- Implementer ran 55 focused tests covering recovery, runtime continuation, cold-host nested recovery, registrar role/schema, Wait recovery, and Request evidence. All targeted cases passed.
- Coordinating implementer reran typecheck and both new focused suites: 18/18 passed. No full integration suite run.

## Decisions
- Original Requests continue to own delegated work.
- Recovery input explicitly identifies Owner-requested continuation and requires inspecting interrupted operations before repeating effects.
- No inference of unfinished work from ordinary delivered Message history; no claim to restore volatile Waits or queue order.

## Outcomes
Implemented Owner-only recovery with fixed verified snapshot, original delivery scheduling, runtime-generated dormant continuation, explicit receipts, and documentation. Source/tests committed in `0eb91a9`, `1747db6`, and `a0ce098`; contract docs in `3fd97a0` and `0f28cdb`. No push or PR.

Known unrelated baseline failure: the full participant-tool registrar suite expects `/Omit template and config/` in the existing conversation-fork description, while baseline source uses different wording. Focused registrar recovery coverage passes; no unrelated fix included. Execution-capacity admission uses the existing normal runtime path; focused capacity coverage explicitly exercises pending-delivery limits. Independent review remains with the requester.

## Surprises and discoveries
A cold host resets Run sequence counters, so Run sequence alone cannot identify continuation admission. Each activation now has a fresh identity, preventing old transcript proof from suppressing a later cold-host continuation.
