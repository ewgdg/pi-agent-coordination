# Interactive Agent view acceptance matrix

This matrix maps the acceptance criteria for issues #63–#69 to production paths and concrete regression tests. Criterion numbers follow the order in each issue body.

## Shared implementation paths

- `src/pi-integration/native-agent-projection.ts` — complete child `InteractiveMode`, detached terminal, native frame/input, lifecycle policy, process-global initialization boundary, failure and exit-request seams.
- `src/presentation/agent-view-surface.ts` — headerless full-window presentation, input prioritization, failure boundary, and Owner shutdown delegation.
- `src/presentation/agent-activity-surface.ts` — native above-editor selected identity, scoped direct-child activity, and Owner-only attention.
- `src/coordination/durable-agent-view.ts` — one retargetable attachment per selected durable Agent view.
- `src/coordination/workflow-coordinator.ts` — Agent Runtime preparation, Run admission, retention, failure transitions, switching, and shutdown.
- `src/runtime/default-child-session-factory.ts` — configured Agent Runtime construction.
- `src/runtime/in-process-agent-host.ts` — prepared Runtime ownership plus exact Run state, fencing, failure, and disposal.

Pi theme configuration is intentionally Workflow-global. The projection boundary restores incidental child initialization changes and Owner callback ownership; explicit theme changes remain shared.

## #63 — Full-window complete Agent modes

| Criterion | Evidence |
|---|---|
| 1. Live ordinary and Moderator complete modes; Owner stays bound | `tests/agent-view.test.ts` — “complete interactive mode while Owner stays bound”; `tests/operational-incidents.test.ts` Moderator view coverage |
| 2. Per-session extensions and one startup | `tests/interactive-host-conformance.test.ts` — child startup isolation and repeated attachment |
| 3. Detached terminal with no physical writes | `ProjectionTerminal`; `tests/native-agent-projection.test.ts` complete projection and compatibility cleanup; PTY Owner-state checks |
| 4. Dormant selection stays passive while retaining commands and UI | `tests/agent-view.test.ts` — Dormant command, editor activation, and startup-modal tests |
| 5. Stable Runtime across Dormant/live/failure/successor transitions | selected startup failure, terminal failure, input-started successor, and Message activation tests in `tests/agent-view.test.ts` |
| 6. Agent-local UI and input features | complete-mode, independent-mode, shortcut/autocomplete, retained drafts/overlays, and child-startup isolation tests |
| 7. Native rendering parity | rich rendering and differential native fullscreen tests in `tests/native-agent-projection.test.ts`, including Markdown, Mermaid, pending/completed tools, custom Messages, and custom entries |
| 8. Long transcript navigation during streaming/resize | streaming-anchor and fullscreen viewport tests plus real PTY scroll/resize tests |
| 9. Exact lifecycle ownership | `tests/run-projection-lifecycle.test.ts`; constructor watcher rollback, repeated projection, and repeated successor resource-baseline tests |
| 10. Real PTY interaction and untouched Owner return | `tests/coordinated-workflow-pty.test.ts` main fullscreen flow; fixture asserts Owner runtime, transcript, editor factory/text/cursor, footer, services, and diagnostics |
| 11. Mechanical private-host compatibility | `tests/host-shape.test.ts`, host module/conformance suites |

## #64 — Agent Runtime and exact Run ownership

| Criterion | Evidence |
|---|---|
| 1. One Runtime mode before model work | projection admission and session-start model-work ordering tests |
| 2. One extension binding/startup per Runtime | repeated attachment conformance and Runtime lifecycle counters |
| 3. Narrow complete projection interface | `PiNativeAgentProjection`; host-shape preflight |
| 4. Complete native frame | fullscreen viewport, rich rendering, retry/compaction, and retained-mode state tests |
| 5. Native input/focus/custom editor/shortcut path | complete-mode custom editor test; shortcut/autocomplete test; streaming custom-editor test |
| 6. Inert detached terminal with live dimensions/callbacks | `ProjectionTerminal`; resize and PTY tests |
| 7. Passive Runtime preparation and in-place Run admission | editor-, command-, session-start-, and Message-activated Run tests |
| 8. Exact clean/failure/termination/shutdown lifecycle | `tests/run-projection-lifecycle.test.ts`, constructor watcher rollback, and `tests/agent-view.test.ts` Runtime lifecycle tests |
| 9. Owner presentation/global consistency | Owner binding assertions, explicit shared-theme tests, process listener/keybinding/theme baselines |
| 10. No partial startup resource | constructor watcher rollback, compatibility failure, initial render failure, selected initialization failure, and PTY failure tests |
| 11. Concrete complete-frame/input/role/lifecycle host coverage | native projection, agent view, operational incident, conformance, and PTY suites |

## #65 — Durable `/agents` attachment

| Criterion | Evidence |
|---|---|
| 1. Complete view without Owner mutation | complete-mode Owner-binding test |
| 2. Native child interaction features | direct input, custom editor, shortcut, autocomplete, commands, overlays, and footer tests |
| 3. Escape to child; `/agents` return/switch | custom-editor Escape and Agent-to-Agent switching tests |
| 4. Dormant selection prepares evidence and editor without admitting work | cold-recovery open/close regression and Dormant Agent view test |
| 5. Extension behavior remains native; model-starting effects admit a Run | UI-only command, command-emitted user message, `session_start` input, and editor submission tests |
| 6. One Runtime spans exact Run transitions | scoped dock identity, failure, and repeated-successor tests |
| 7. Exact `interactive_selection` Runtime retention | attachment, return, and release conformance tests |
| 8. Other retention preserves live mode | multiply retained switching and retained resource-reload tests |
| 9. Terminal failure keeps the same Runtime view while becoming Dormant | unit and PTY terminal-failure tests |
| 10. Message activates the attached Runtime before Delivery execution | Message-activated Runtime test |
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
| 9. Reload affects later Runtime preparations, not retained modes | retained-mode reload test and successor Runtime factory-resolution test |
| 10. Command collision safety | generic child-view command conformance test |
| 11. Real extensions and complete native modes | native projection, agent view, interactive host conformance, and PTY suites |

## #67 — Long transcript navigation with active editor

| Criterion | Evidence |
|---|---|
| 1. Initial newest content with editor/footer | complete fullscreen viewport and Dormant Runtime/editor tests |
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
| 4. Idempotent switch/dispose/duplicate close/teardown/shutdown | durable attachment and surface tests; prepared-Runtime and unselected startup custom-UI cancellation/shutdown tests |
| 5. Selected terminal failure retains the Runtime; invalid initialization closes | selected startup and terminal failure unit/PTY tests |
| 6. Input, extension, and Message work activate the attached Runtime once | editor submission, command-emitted and `session_start` user messages, and Message activation tests |
| 7. Sole view release once | exact retention conformance test |
| 8. Other retention prevents premature disposal | retained switching and resource-reload tests |
| 9. Repeated attachment does not recreate/start/grow resources | repeated attachment conformance and repeated projection resource baseline |
| 10. Repeated Runs reuse one selected Runtime and return resources | repeated successor test compares one startup/shutdown pair, process listeners, and active process resources |
| 11. Shutdown cleanup continues after projection failure | `tests/run-projection-lifecycle.test.ts` cleanup-continuation test |
| 12. Failure/switch/noninteractive PTY matrix | input, render, initialization, terminal Run, switching, and unviewed disposal PTYs |
| 13. Stable interfaces/process observations | lifecycle tests use projection/host interfaces; resource tests use process listeners and `process.getActiveResourcesInfo()` |
| 14. Release gates | full test, conformance, typecheck, package dry-run, audit, and diff-check commands documented in the completed plan |

## #69 — Dormant selection remains passive

| Criterion | Evidence |
|---|---|
| 1. Cold-recovered unresolved Creation Request remains Dormant without moderation | `tests/cold-host-recovery.test.ts` — cold-recovered answer-obligated open/close regression |
| 2. Real `/agents` open/close creates no Run or transcript evidence | same cold-recovery regression through `openDormantAgentView()` and Owner return |
| 3. Observation remains `phase: "dormant"` while open | cold-recovery and Dormant command tests |
| 4. First editor submission activates one exact Run and commits once | Dormant editor-submission test |
| 5. Extension behavior retains native semantics and can activate work | UI-only command, command-emitted user message, and `session_start` input tests |
| 6. Message Delivery activates the same projection before execution | ordinary Message-activated Runtime test |
| 7. Genuine live settled obligation still moderates | `tests/operational-incidents.test.ts` Obligation Stall coverage |
