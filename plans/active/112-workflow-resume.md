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
- Source and test implementation delegated as one bounded unit; documentation and plan remain with coordinating implementer.

## Decisions
- Original Requests continue to own delegated work.
- Recovery input explicitly identifies Owner-requested continuation and requires inspecting interrupted operations before repeating effects.
- No inference of unfinished work from ordinary delivered Message history; no claim to restore volatile Waits or queue order.

## Outcomes
Pending implementation and validation.
