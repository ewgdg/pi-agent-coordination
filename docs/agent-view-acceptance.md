# Interactive Agent view acceptance matrix

This matrix maps the acceptance criteria for issues #63–#68 to production paths and concrete regression tests. Criterion numbers follow the order in each issue body.

## Shared implementation paths

- `src/pi-integration/native-agent-projection.ts` — complete child `InteractiveMode`, detached terminal, native frame/input, lifecycle policy, process-global initialization boundary, failure and exit-request seams.
- `src/presentation/agent-view-surface.ts` — full-window presentation, one-row identity chrome, input prioritization, mouse translation, failure boundary, and Owner shutdown delegation.
- `src/coordination/durable-agent-view.ts` — one retargetable attachment per selected durable Agent view.
- `src/coordination/workflow-coordinator.ts` — live/Dormant acquisition, retention, transitions, successor handoff, switching, and shutdown.
- `src/runtime/default-child-session-factory.ts` — exact live and passive Dormant session/projection construction.
- `src/runtime/in-process-agent-host.ts` — exact Run startup, terminal lifecycle ordering, failure, and disposal.

Pi theme configuration is intentionally Workflow-global. The projection boundary restores incidental child initialization changes and Owner callback ownership; explicit theme changes remain shared.

## #63 — Full-window complete Agent modes

| Criterion | Evidence |
|---|---|
| 1. Live ordinary and Moderator complete modes; Owner stays bound | `tests/agent-view.test.ts` — “complete interactive mode while Owner stays bound”; `tests/operational-incidents.test.ts` Moderator view coverage |
| 2. Per-session extensions and one startup | `tests/interactive-host-conformance.test.ts` — child startup isolation and repeated attachment |
| 3. Detached terminal with no physical writes | `ProjectionTerminal`; `tests/native-agent-projection.test.ts` complete projection and compatibility cleanup; PTY Owner-state checks |
| 4. Passive Dormant evidence and one first-input successor | `tests/agent-view.test.ts` — Dormant editor successor test |
| 5. Durable live/failure/Dormant/successor transitions | selected startup failure, terminal failure, Dormant successor, and Message successor tests in `tests/agent-view.test.ts` |
| 6. Agent-local UI and input features | complete-mode, independent-mode, shortcut/autocomplete, retained drafts/overlays, and child-startup isolation tests |
| 7. Native rendering parity | rich rendering and differential native fullscreen tests in `tests/native-agent-projection.test.ts`, including Markdown, Mermaid, pending/completed tools, custom Messages, and custom entries |
| 8. Long transcript navigation during streaming/resize | streaming-anchor and fullscreen viewport tests plus real PTY scroll/resize tests |
| 9. Exact lifecycle ownership | `tests/run-projection-lifecycle.test.ts`; constructor watcher rollback, repeated projection, and repeated successor resource-baseline tests |
| 10. Real PTY interaction and untouched Owner return | `tests/coordinated-workflow-pty.test.ts` main fullscreen flow; fixture asserts Owner runtime, transcript, editor factory/text/cursor, footer, services, and diagnostics |
| 11. Mechanical private-host compatibility | `tests/host-shape.test.ts`, host module/conformance suites |

## #64 — Exact Run and Dormant projection ownership

| Criterion | Evidence |
|---|---|
| 1. One mode before binding/model work | projection admission and session-start model-work ordering tests |
| 2. One extension binding/startup per child session | repeated attachment conformance and repeated lifecycle counters |
| 3. Narrow complete projection interface | `PiNativeAgentProjection`; host-shape preflight |
| 4. Complete native frame | fullscreen viewport, rich rendering, retry/compaction, and retained-mode state tests |
| 5. Native input/focus/custom editor/shortcut path | complete-mode custom editor test; shortcut/autocomplete test; streaming custom-editor test |
| 6. Inert detached terminal with live dimensions/callbacks | `ProjectionTerminal`; resize and PTY tests |
| 7. Passive Dormant mode | Dormant native projection and Dormant successor tests |
| 8. Exact clean/failure/termination/replacement/shutdown disposal | `tests/run-projection-lifecycle.test.ts`, constructor watcher rollback, and `tests/agent-view.test.ts` lifecycle tests |
| 9. Owner presentation/global consistency | Owner binding assertions, explicit shared-theme tests, process listener/keybinding/theme baselines |
| 10. No partial startup resource | constructor watcher rollback, compatibility failure, initial render failure, selected initialization failure, and PTY failure tests |
| 11. Concrete complete-frame/input/role/lifecycle host coverage | native projection, agent view, operational incident, conformance, and PTY suites |

## #65 — Durable `/agents` attachment

| Criterion | Evidence |
|---|---|
| 1. Complete view without Owner mutation | complete-mode Owner-binding test |
| 2. Native child interaction features | direct input, custom editor, shortcut, autocomplete, commands, overlays, and footer tests |
| 3. Escape to child; `/agents` return/switch | custom-editor Escape and Agent-to-Agent switching tests |
| 4. Dormant open is passive | Dormant open and native Dormant projection tests |
| 5. First Dormant input starts/attaches/commits once | Dormant successor test |
| 6. Durable identity independent of exact session | one-row identity surface and failure/successor retarget tests |
| 7. Exact `interactive_selection` retention | attachment, return, and release conformance tests |
| 8. Other retention preserves live mode | multiply retained switching and retained resource-reload tests |
| 9. Terminal failure retargets same view to Dormant | unit and PTY terminal-failure tests |
| 10. Message successor attaches before Delivery | Message-started successor test |
| 11. Atomic selector handoff | `tests/agent-selector-surface.test.ts` preparation-focus test |
| 12. Child UI local before/during/after attachment | interactive host conformance child-UI test |
| 13. No Owner rebind or generic command | complete-mode assertions and generic command collision test |
| 14. Real-session transition matrix | `tests/agent-view.test.ts` and Moderator operational tests |
| 15. PTY interaction and exact Owner restoration | main fullscreen PTY flow |

## #66 — Rendering and independent UI state

| Criterion | Evidence |
|---|---|
| 1. Markdown/Mermaid/tool/custom line parity | rich renderer test and differential native fullscreen test |
| 2. Pending/completed/streaming/working/retry/compaction updates | rich, streaming-anchor, retry/compaction, and concurrent retained-mode tests |
| 3. Custom editor/footer/status/widget/notification/dialog/selector/shortcut/command | complete-mode test, shortcut/autocomplete test, startup-dialog test, independent-mode test |
| 4. Distinct extension instances and one startup | interactive host conformance lifecycle counters |
| 5. Concurrent transcript/draft/footer/status/pending/retry/compaction/widget/overlay state | retained child modes test plus durable Agent-to-Agent switch test |
| 6. No state from another Agent | independent-mode switch and retained-mode negative assertions |
| 7. Hidden UI cannot mutate Owner/terminal | child startup isolation conformance and detached terminal implementation |
| 8. Shared theme/keybinding consistency | retained shared-config test; session-start and paused-startup explicit shared-theme tests |
| 9. Reload affects later modes, not retained modes | “later Runs use reloaded factories without mutating a retained child mode”; successor factory resolution test |
| 10. Command collision safety | generic child-view command conformance test |
| 11. Real extensions and complete native modes | native projection, agent view, interactive host conformance, and PTY suites |

## #67 — Long transcript navigation with active editor

| Criterion | Evidence |
|---|---|
| 1. Initial newest content with editor/footer | complete fullscreen viewport and Dormant view tests |
| 2. Bounded wheel/drag/page/end navigation plus text entry | native viewport test, Agent-view surface routing, and main PTY flow |
| 3. Tail-only partial/completed follow | streaming-anchor test and PTY chunked stream |
| 4. Scrolled logical anchor survives append | streaming-anchor test and PTY anchor assertion |
| 5. Opening after partial output shows current state | projection-before-model admission and session-start model-work ordering tests |
| 6. Working/retry/compaction/pending/completed layout | native transition, rich rendering, streaming, and retained-mode tests |
| 7. Narrow/wide reflow preserves editor and width bounds | native viewport resize test and 100×30 PTY test |
| 8. Terminal-height full frame | Agent-view surface and native projection height assertions |
| 9. Escape-sensitive custom editor during stream/scroll/resize | streaming-anchor test installs a custom Escape editor, scrolls, resizes, and dispatches Escape |
| 10. Exact Owner return including cursor | main PTY fixture records and verifies Owner editor factory/text/cursor plus transcript/footer; complete-mode test verifies runtime/services/diagnostics |
| 11. Real PTY matrix | chunked streaming, 80×24 and 100×30, long transcript, editing, tail and scrolled-away states in `tests/coordinated-workflow-pty.test.ts` |

## #68 — Failure, race, and exhaustive disposal

| Criterion | Evidence |
|---|---|
| 1. Constructor/init/bind/startup/render/compatibility failure cleanup | footer watcher construction rollback, native projection failure tests, lifecycle rollback tests, and selected initialization PTY |
| 2. Bounded async render/input failure | Agent-view surface tests, real child failure tests, and failure PTYs |
| 3. No selector handoff input leak | selector preparation-focus test and prioritized input routing tests |
| 4. Idempotent switch/dispose/duplicate close/teardown/shutdown | durable attachment and surface tests; shutdown tests |
| 5. Selected failure replaces before disposal | selected startup and terminal failure unit/PTY tests |
| 6. Dormant and Message successor attach before work, once | Dormant first-input and Message successor tests |
| 7. Sole view release once | exact retention conformance test |
| 8. Other retention prevents premature disposal | retained switching and resource-reload tests |
| 9. Repeated attachment does not recreate/start/grow resources | repeated attachment conformance, repeated projection resource baseline |
| 10. Repeated successors create/dispose exact lifecycles and return resources | repeated successor test compares startup/shutdown multisets, process listeners, and active process resources |
| 11. Shutdown continues after one cleanup throws | throwing Dormant cleanup test |
| 12. Failure/switch/noninteractive PTY matrix | input, render, initialization, terminal Run, switching, and unviewed disposal PTYs |
| 13. Stable interfaces/process observations | lifecycle tests use projection/host interfaces; resource tests use process listeners and `process.getActiveResourcesInfo()` |
| 14. Release gates | full test, conformance, typecheck, package dry-run, audit, and diff-check commands documented in the active plan |
