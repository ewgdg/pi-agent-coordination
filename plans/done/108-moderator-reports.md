# Durable Moderator defect reports

## Goal and intention
Moderator investigates and preserves evidence, attempts autonomous recovery, then reports suspected runtime defects without blocking the run or asking for a human answer. Human review is separate from incident resolution.

## Scope and constraints
Immutable, workflow-durable reports with exact reporter/transcript/tool-call identity; pending Attention Inbox and retained report history; dedicated read-only viewer; explicit Mark read; ticket-ready Copy; View reporter selects the stable Moderator identity. No tickets, file exports, generic notifications, or incident closure side effects.

## Work plan
1. Inspect existing coordination, retained transcript and Pi presentation/navigation contracts.
2. Add durable report model/store and tests (report-store delegate; isolated new files).
3. Add selector and dedicated report UI and tests (report-ui delegate; isolated presentation files).
4. Integrate Moderator-only tool, owner authority and process transport; wire Owner and child presentation paths.
5. Document behavior/navigation limits, run targeted tests and typecheck, commit all task-owned changes.

## Validation
Store replay/idempotency/acknowledgment tests; selector/view action and non-ack tests; tool/transport role contracts and coordinator report/incident separation; relevant existing focused suites and typecheck. Avoid full integration suite.

## Progress
- Initial architecture inspection: owner transcript is the durable workflow authority; selected child UI uses owner Control RPC. Reports must be present in both paths.

## Decisions
- Append immutable reports and separate read receipts to Owner transcript, independent of Moderator transcript retention and incident state.
- Report selection is a distinct action, not agent selection. Exact original source is retained even after View reporter opens its current stable context.

- Durable model/store committed in 047899e; five focused tests pass, including real file reopen and immutable retry/read semantics.
- Moderator-only tool and authenticated owner Control transport wired; initial role-contract test confirmed missing report tool before implementation.
- Pi README, extensions.md, tui.md, sessions.md, session-format.md and relevant bookmark/entry/overlay examples inspected. Public navigateTree changes branch leaf; switchSession replaces active runtime. Neither is a read-only source jump. Keep exact source references and stable View reporter selection, without native session replacement.

- Added report attention to the existing Owner activity dock (same scope as Human/Operational attention), rather than introducing notifications. Selector history transports report snapshots to selected-child UI; acknowledgment is a separate presentation-only Control intention.

## Validation outcomes
- `npm run typecheck`: passes.
- 97 focused tests pass across report model/store/view, selector/activity, local/child commands, transport, registrar, extension conformance and runtime preparation. Command excludes the existing unrelated Spawn-description assertion described below.
- `node tests/support/run-test-suite.ts process --file=moderator-report-integration.test.ts`: passes. Real Moderator reports without Human waiting, cannot resolve the still-stalled condition, then recovers independently; unread report survives resolution and Owner file reopen.
- Focused cold recovery standalone-Moderator test passes, including report tool availability on recovered Runtime.
- UI tests verify immutable report content, distinct selection action, explicit-only acknowledgment, retries/errors, source visibility, scrolling and terminal-control safety. Local and child command tests prove no Agent acquisition until View reporter.
- Publication renderer failure test was added red before correcting a misleading pending label.

## Existing test failures, not expanded into this issue
A temporary archive of `origin/main` reproduced both failures unchanged:
1. Registrar Spawn-description test expects “Omit template and config”, whereas current schema says configuration is independent.
2. Operational Incident initial Moderator tool-list test omits the installed Pi builtin `powershell`.
This issue updates that test's expected list only for its new `report_to_user` tool, not the unrelated builtin mismatch. No full slow suite was run.

## Outcomes and retrospective
Completed durable nonblocking reports, explicit acknowledgment/history, Owner activity attention, dedicated read-only UI, stable reporter selection and ticket-ready clipboard copy. Store and UI commits are separate review boundaries, followed by integration/docs. No automatic tickets, export, session rewinding, general notification abstraction or incident-resolution shortcuts were introduced.

Source navigation limitation is intentional: installed public Pi navigation APIs mutate the current session/context, so the report preserves and copies exact original references but View reporter opens the stable Moderator's current context. Ephemeral/deleted Owner transcripts cannot provide durable history; clipboard behavior follows Pi.

Investigation/test logs are retained in the agent artifact output for project `pi-agent-coordination`, date `2026-09-07`, task `108-moderator-reports`.

## Independent review corrections
- Added delayed local and child View reporter regressions first; both failed because the report was already closed while preparation waited.
- Reporter preparation now runs inside the focused report surface. It shows “Opening reporter…” and consumes input until the replacement is ready. Preparation failure remains visible in the same unread report and allows retry; successful completion closes it without acknowledging.
- Report dock labels and symptoms are sanitized before preview formatting, consistently with the dedicated report view. An OSC regression covers both fields.
- Scoped validation: 58 tests passed across report surface, local/child selector, activity dock and selector suites; TypeScript and whitespace checks passed. No incident, acknowledgment, clipboard, or session-navigation semantics expanded.
