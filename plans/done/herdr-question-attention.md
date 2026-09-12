# Herdr question attention (#122)

## Goal and constraints
Report human input pending immediately through the root Pi event bus. Coalesce questions into one balanced `herdr:blocked` span, without CLI calls, progress gates, settlement fabrication, or Request/Wait changes.

## Work plan
1. Trace question lifecycle and root reload/bootstrap ordering.
2. Test the generic pending-input snapshot and Pi event adapter, then implement the smallest binding.
3. Exercise real Human Requests and Owner Wait, plus shutdown/reload and no-listener operation.
4. Document supported behavior and commit validated changes.

## Validation seams
The agreed issue checks define the seams: Human Request admission/submission/cancellation, root Pi event bus, and existing Wait results. Use focused Node test files, not the full integration suite.

## Discoveries
- Coordination `ask_user_question` is registered for ordinary children and Moderator; Owner does not receive that tool from this package. It routes to `HumanRequestCoordinator.ask`, not `ctx.ui.custom` or a shared question-UI event.
- Human Requests retain submitted/fenced bookkeeping until native result commitment. Pending-human-input attention must distinguish those phases from an open question without altering result guards or the attention inbox.
- Installed Pi 0.85.1 has generic `ui_prompt_start/end`, but these include selectors and other unrelated UI and are not coordination Human Request events. No separate installed external `ask_user_question` provider was found in Pi built-ins or configured extension packages.
- Herdr Pi integration v8 reference-counts `herdr:blocked`; root-session readiness is set in `session_start`. Bind after all startup handlers (`resources_discover`) to avoid extension load-order loss. Pi reload emits shutdown, replaces extensions, then startup/resources discovery; workflow coordinator is retained.

## Progress
- Implementation, focused validation, and documentation complete.

## Decisions and implementation
- Added a generic pending-question snapshot that includes open/submitted Human Requests but excludes fenced calls. Native Answer commitment remains authoritative; no Request/Wait behavior changed.
- Added a root-only event adapter with one activation per pending-question episode, balanced shutdown, and snapshot reconstruction after reload. Uses no environment assumptions or Herdr executable.
- Kept generic UI prompts and unrelated third-party question tools outside this feature: they do not share this package's Human Request lifecycle.

## Validation and outcomes
- Adapter unit tests: 3 passed (coalescing, refresh deduplication, shutdown/reload, inactive source).
- Production Owner parking tests: 4 focused cases passed, including explicit pending `agent_wait`, a question alongside autonomous work, and root reload with a retained question.
- Human Request integration: 3 new cases passed for two simultaneous questions, reload, first Answer commitment, and final Answer/interruption/shutdown. Existing no-interactive-editor rejection case also passed.
- Activation tests: 6 cases/subcases passed. Existing hidden Owner extension reload test passed. Typecheck and diff whitespace checks passed.
- Actual installed Herdr Pi integration v8 was exercised against an isolated recording Unix socket with this adapter: `working → blocked → working → blocked → idle`, with no duplicate report from repeated refresh and a removed subscription on disposal. No live Herdr session was notified or controlled. Upstream v9 was checked online; its blocked-event contract is unchanged.
- Herdr source confirms request sound is keyed to entry into semantic blocked; actual audible/toast delivery remains controlled by Herdr preferences and was not exercised against the user's session. A resource reload re-establishes the blocker; Herdr owns presentation of that restored state.
- An exploratory existing Human Request case (`one native text Answer ...`) failed before question admission: its child fixture exhausts faux responses after the obligation reminder and never reaches expected settled state. No unrelated fixture/runtime changes were made. The new tests ask immediately from the Creation Request and avoid this pre-existing setup failure.
- Full suites were not run; changes are limited to the attention snapshot, root adapter, focused tests, and documentation.

## Retrospective
The important boundary is pending Human Requests, not an open modal or exhausted autonomous progress. Deferring initial publication until resource discovery avoids Herdr extension load-order loss without timers or host-specific polling.
