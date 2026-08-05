# Goal

Implement GitHub issue #48: independently review overdue root Pi tool calls for answer-obligated Agents under exact attendance rules, allow policy-bounded Moderator renewal, and limit generation recovery to adapter-proven same-Run continuation that cannot repeat a committed tool effect.

# Intention

Add one volatile operation-review watcher beside the existing Operational Incident coordinator. Observe only root Pi lifecycle and transcript-commit boundaries, keep one captured policy interval per admitted call, and feed expired calls into the existing Moderator creation, duplicate suppression, failure fallback, and Resolution path. Keep generation reconciliation at the concrete Pi adapter boundary so ordinary retry heuristics cannot regenerate prompts or repeat tools.

# Scope & Constraints

- Track every unresolved root Pi tool call independently by its exact committed `ToolCallPointer` and captured Workflow Policy snapshot.
- Classify a committed Pi tool batch as blocking when any issued tool declares sequential execution and as asynchronous only when the complete batch is parallel. Blocking intervals begin at execution admission; asynchronous intervals cover only continuous unattended Idle time.
- Review `ask_user_question` before Human Request commit and again during result-commit work, while excluding the human waiting interval.
- End an applicable interval on terminal tool-result commit, final Answer Obligation clearance, pre-expiry attendance resumption for asynchronous work, or valid Moderator renewal. Ignore progress, logs, heartbeat, partial output, and internal awaits.
- Expiry creates only an `operation_review` condition and minimal Moderator trigger. It does not abort, retry, interrupt, terminate, or claim an operation outcome.
- Let any Moderator renew an exact unresolved reviewable call in its Workflow with a positive interval no greater than the call's captured policy interval. Expected completion races return `stale`.
- Admit generation recovery only through explicit proof of same-Run continuation and non-repeatable committed tool effects. The current Pi adapter must not use generic regenerated-prompt retries for coordinated Runs.
- Treat exhausted or indeterminate generation recovery as ordinary exact-Run failure when an Answer Obligation remains; do not create a reconciliation or Operation Review trigger.
- Preserve volatile handling and cold-host behavior. Do not persist timers, review state, attendance, adapter state, or new lifecycle records.

# Confirmed Test Seams

Issue #48 explicitly requires these stable seams, extending the real-Pi coordinator seam already used by #47:

1. A controllable-clock operation-review contract for independent blocking/asynchronous intervals, attendance, parallel calls, Human waiting, obligation clearance, commit races, and renewal.
2. Role-bound `WorkflowCoordinator` views backed by real in-process Pi sessions for committed pointers, minimal Moderator Input, renewal receipts, Resolution, and no operational side effects.
3. A narrow generation-adapter contract for proven same-Run continuation and exhaustive rejection of tool calls, ambiguous connection loss, regenerated prompts, malformed calls, context/authentication/policy/quota/invalid-request failures, and uncertain external effects.

Tests observe public receipts, transcript evidence, Moderator inputs, and Run behavior; they do not inspect watcher maps, timers, or private handling state.

# Work Plan

1. Add the controllable-clock tracer slice for one blocking call: admission, policy capture, obligation gating, expiry, terminal commit, and a minimal operation-review snapshot.
2. Add asynchronous attendance slices, independent parallel calls, pre-expiry resumption, and final-obligation clearance without treating progress updates as renewal.
3. Add Human Request phase transitions so request commit suspends review and submitted or interrupted result-commit work starts a fresh interval until terminal result evidence.
4. Extend Moderator trigger/input validation, metadata, presentation, Handling Keys, condition revalidation, failure fallback, and Resolution with `operation_review`.
5. Extend `moderator_control` with exact-pointer renewal, policy bounds, `renewed`/`stale` receipts, and serialized completion/expiry races without changing the watched tool or Run.
6. Define and integrate the generation-reconciliation adapter policy, disable unsafe generic Pi continuation for coordinated Runs, and prove safe continuation plus every rejected class.
7. Update current design documentation for operation timing, renewal, minimal trigger evidence, and concrete adapter behavior.
8. Run focused tests and typechecking throughout. Then run the required parallel Standards and Spec review against the pinned base, fix confirmed findings, and perform the final broad validation once before committing semantically with `Closes #48`.

# Validation

- Focused red-green cycles in a new operation-review test file, then focused coordinator/incident and adapter test files.
- `npm run typecheck` regularly and the affected focused test files after each vertical slice.
- Parallel Standards and Spec review against `2e4f76b899459b01207cf1fac1331ec2c9d511ca`, with issue #48 and issue #24's accepted decision as the Spec sources.
- Final once: `npm test`, `npm run typecheck`, `npm run build`, `npm pack --dry-run`, `npm audit`, and `git diff --check`; inspect package contents for source/dist parity and stale compiled modules.

# Progress

- [x] Read issue #48, its accepted operation-review decision, repository guidance, current domain/docs, prior #43/#47 plans, current Pi 0.83 lifecycle/retry surfaces, and the required TDD/review instructions.
- [x] Pin the clean starting branch at `2e4f76b899459b01207cf1fac1331ec2c9d511ca`.
- [x] Confirm the ticket-defined controllable-clock, real-Pi coordinator, and generation-adapter seams.
- [x] Complete operation-review timing slices.
- [x] Complete Human Request and Moderator renewal slices.
- [x] Complete safe generation-reconciliation slices.
- [x] Complete documentation and parallel Standards/Spec review fixes.
- [x] Complete final validation, package inspection, plan archival, and semantic commit.

# Surprises & Discoveries

- Pi commits the assistant tool-call source before `tool_execution_start`, but terminal tool-result persistence occurs after extension `message_end`. Exact completion therefore needs transcript revalidation at the next awaited boundary and again inside timer/renewal races rather than treating `tool_execution_end` as commit proof.
- Pi 0.83's ordinary automatic retry removes an error from live context and calls `Agent.continue()`. That is regenerated-prompt continuation, so it cannot qualify as issue #48 Automatic Reconciliation for coordinated Runs.
- Pi's current root tool execution contract blocks the model turn until every issued tool result is finalized. The operation watcher still needs an explicit asynchronous classification input because the accepted protocol defines attended background operations and tests that state machine independently.
- `SettingsManager.applyOverrides()` changes only the live settings view. Coordinated Runs use it to disable regenerated-prompt retry and overflow compaction without persisting changes to user configuration.
- OpenAI Codex `auto` transport can fall back from WebSocket to a second SSE request before yielding a stream. Coordinated sessions therefore resolve only that `auto` case to SSE; an explicit transport remains explicit.

# Decisions

- Use the ticket-mandated controllable clock as a small scheduling dependency, not global fake timers or wall-clock sleeps.
- Resolve exact tool-call sources and terminal results from committed transcript evidence. Tool lifecycle events only announce when revalidation should occur.
- Feed expired reviews into the existing Operational Incident coordinator instead of creating a second Moderator lifecycle or attempt store.
- Keep the minimal operation-review trigger free of obligation lists, diagnostics, deadlines, adapter details, and inferred outcomes; the exact tool pointer and captured interval are sufficient.
- Treat the concrete Agent Session as the exact Run incarnation for generation proof. Each provider stream receives an opaque Run-local generation handle, and a trusted adapter can return only a same-handle text continuation recipe; it receives no prompt retry callback.
- Clear every volatile reviewed call when its exact Run ends so transcript evidence from a failed Run cannot reappear as a successor-Run Operation Review.
- A valid explicit renewal starts its selected interval immediately. Ordinary asynchronous intervals still require uninterrupted Idle, but later attendance cannot silently discard a Moderator-selected renewal interval.

# Outcomes & Retrospective

Every answer-obligated root tool call now receives independent, policy-captured review coverage without changing the operation itself. Human waiting is excluded, exact committed completion ends review, final obligation clearance permanently removes coverage, and Moderator renewal is exact-pointer, bounded, and race-safe. Expiry enters the existing transient Operational Incident path with minimal evidence.

Automatic Reconciliation is limited to adapter-proven same-Run text continuation. Coordinated Pi sessions disable regenerated-prompt retry, overflow auto-compaction, provider retry, and the OpenAI Codex `auto` WebSocket fallback that could issue a second request. Rejected or exhausted recovery becomes ordinary exact-Run failure and never repeats a committed tool effect.

Independent Standards and Spec review passed after fixes for attendance-independent renewal, transcript revalidation, exact Run cleanup, already-streamed text preservation, and process-local provider retry suppression.

The final gate completed on August 5, 2026:

- `npm test`: 181 tests passed.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm pack --dry-run`: passed with 184 files.
- `git diff --check`: passed before archival.
- Package inspection found both new compiled module triplets, no stale compiled module, and exact source/dist module parity.

`npm audit` reports three existing transitive advisories under `@earendil-works/pi-coding-agent` (one moderate and two high). The suggested automatic fix changes that dependency incompatibly, so issue #48 does not apply it.
