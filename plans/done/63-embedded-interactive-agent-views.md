# Goal

Preserve the complete Interactive Selection experience while removing Owner runtime and native `InteractiveMode` rebinding. A selected non-Owner Agent must expose its own complete Pi presentation and accept direct human input through a semi-isolated child-owned mode, while the exact Owner presentation remains mounted behind it.

# Intention

Treat every exact live child or Moderator Run as the owner of one complete embedded `InteractiveMode`. Its detached terminal owns dimensions and input callbacks but cannot write to the physical terminal. `/agents` attaches the full child renderer to a durable Agent view and forwards terminal input into that renderer. Selecting a Dormant Agent starts one no-prompt successor so the selected view has normal commands and extensions.

# Scope & Constraints

- Preserve prior live and Dormant Agent editor interaction, footer, extension UI, commands, shortcuts, and custom editor behavior.
- The Owner runtime session, services, diagnostics, transcript, editor, footer, extension context, and physical terminal remain continuously bound and mounted.
- Each exact child session binds its own extensions and emits `session_start` exactly once. View attachment never replays session lifecycle.
- Use Pi's complete native renderer and terminal input path. Do not reconstruct transcript/editor/footer rows in coordination code.
- A live mode remains exact-Run-owned. Selecting a Dormant Agent starts one exact successor without submitting model input; only a post-failure Dormant presentation remains view-owned.
- Durable selection follows Agent identity across live failure, Dormant presentation, and successor startup.
- The outer view must not steal Escape or ordinary editor keys. `/agents` is the canonical selection and return path.
- Keep Pi private coupling behind one deep adapter and fail mechanically on host drift.
- Prefer a focused Pi seam over broad private wiring if the installed renderer cannot expose its already-computed frame cleanly.
- No `/child-view` command and no Owner native runtime rebind.

# Confirmed Test Seams

1. Real `/agents` command flow through Pi's `ExtensionUIContext.custom`, complete child renderer, and native terminal input callback.
2. The Pi-native projection interface as the stable complete-renderer/input/lifecycle seam.
3. Real PTY behavior proving direct child editing and exact return to the mounted Owner presentation.
4. Existing coordinator status, durable transcript, exact-Run retention, and concrete host-shape conformance interfaces.

# Work Plan

1. Add one failing real-session tracer test: `/agents` displays the live child's native editor/footer, native terminal input reaches that child, and Owner state remains unchanged.
2. Deepen the projection adapter to own a complete initialized child `InteractiveMode`, detached terminal input/dimensions, renderer changes, and exact disposal. Let the mode bind child extensions and emit `session_start` once.
3. Replace the manual Agent-view transcript/status compositor with the complete child renderer and terminal input forwarding. Make selector-to-view focus transfer atomic.
4. Start one no-prompt successor during Dormant selection so the attached complete mode immediately owns normal commands, extensions, and later input.
5. Restore `/agents` switching from child views, including return to Owner, while preserving child editor keys and unfinished text.
6. Expand parity/isolation coverage for custom editors, footer, widgets, statuses, notifications, child overlays, concurrent modes, and resource reload.
7. Complete streaming/scroll/resize PTY behavior through the native child layout.
8. Complete exact release, failure, race, active-handle, and exhaustive disposal tests, including reviewer findings.
9. Rewrite repository documentation to state the complete interactive design directly and remove reduced read-only semantics.
10. Run typecheck, full regression, conformance, package dry run, production audit, and diff hygiene; then move this plan to `plans/done/`.

# Progress

- [x] Corrected GitHub #63–#68 around behavior-preserving complete Agent views.
- [x] Reopened #64 as the complete child-mode projection owner.
- [x] Confirmed test seams through the accepted issue hierarchy.
- [x] Completed exact live-mode initialization, detached terminal ownership, one-time extension startup, model admission, and exact disposal.
- [x] Completed full native rendering and terminal input through a fullscreen child layout with transcript navigation and resize.
- [x] Completed durable live, Dormant-selection successor, failure, Message-successor, Owner-return, and Agent-to-Agent switching behavior.
- [x] Made selector preparation retain focus until the target mode is ready.
- [x] Covered child custom editors, footer, widgets, commands, overlays, ordinary/Moderator input, Owner isolation, and repeated startup lifecycle.
- [x] Rewrote repository documentation around complete interactive Agent modes.
- [x] Hardened embedded lifecycle ownership: no child process listeners, exits, runtime disposal, or fatal process path; exact shutdown and extension UI cleanup occur once.
- [x] Serialized global projection initialization and child service preparation, restored Owner theme callbacks/keybindings, isolated settings, and detached compatibility cleanup from the physical terminal.
- [x] Covered startup dialogs before Run admission, command-capable Dormant activation, post-failure presentation policy, mouse coordinate translation, process listener stability, `/quit`, Ctrl-D, repeated Ctrl-C, and `session_shutdown`.
- [x] Hardened switch acquisition against starting and replaced target projections and stale Dormant resources.
- [x] Completed full regression, conformance, typecheck, real PTY, package dry-run, production audit, diff hygiene, and repeated-suite validation.
- [x] Fixed regular-Owner mouse reporting and prioritized complete Agent-view input ahead of fullscreen Owner viewport interception, including wheel, scrollbar drag, navigation keys, and SGR/X10 header translation.
- [x] Completed human fullscreen mouse retest and independent issue-by-issue #63–#68 acceptance review.
- [x] Resolved the exposed-startup stale view and unbounded render/input failure findings with exact terminal lifecycle notification, bounded view failure, and real-mode regressions.
- [x] Routed child `/quit`, Ctrl-D, and repeated Ctrl-C intent to Owner-owned graceful shutdown without giving embedded modes process ownership.
- [x] Confirmed theme configuration is intentionally Workflow-global shared Pi state; Agent-local theme isolation is not a requirement.
- [x] Completed the criterion-to-evidence matrix in `docs/agent-view-acceptance.md`, including native differential rendering, retry/compaction, shortcuts/autocomplete, concurrent drafts/overlays/pending state, resource reload, streaming custom-editor behavior, Owner cursor restoration, repeated successors, and process-resource baselines.
- [x] Bounded incidental presentation restoration before `session_start`; explicit child or Owner theme changes during startup remain Workflow-global.
- [x] Deferred Pi footer git-watcher startup until complete mode construction succeeds, closing the final constructor-failure resource leak with a real `FSEventWrap` rollback/recovery regression.
- [x] Bound Dormant selection to one observed startup sequence, canceled pending startup UI before disposal, and fenced every child start before shutdown enters Agent lanes, preventing stale-target retries and selected or unselected startup deadlocks.

# Decisions

- Keep and adapt the current uncommitted durable attachment, exact-Run retention, transition, and Owner-preservation work rather than resetting it.
- Replace the reduced `transcript`/`runStatus` projection interface and manual read-only surface.
- A child `session_start` runs once for each exact child session; only repeated execution for the same session is forbidden.
- Terminal dimensions remain renderer-owned. The overlay does not introduce a parallel layout contract.
- The child mode owns its normal editor submission semantics through `getUserInput()`; the adapter runs only that native input pump rather than Pi's process-level `run()` startup checks.
- Selecting Owner from the child mode's `/agents` surface closes the active durable attachment in the existing Agent-view lane.
- Selecting a Dormant roster entry is a Run-start trigger, not a passive presentation action. It starts one successor with selection retention and no model input so commands and extensions belong to a normal exact Run.

# Surprises & Discoveries

- Pi's `Terminal.start(onInput, onResize)` provides the native input-dispatch seam for an embedded renderer. A detached terminal retains those callbacks and accepts forwarded overlay input without reaching into the child editor.
- Pi's fullscreen renderer applies height through its terminal-owned layout loop. The guarded adapter calls the native synchronous render pass and exposes its already-computed screen frame rather than reconstructing or independently clipping transcript/editor rows.
- A real `script(1)` PTY can report zero dimensions through `process.stdout` even while Pi's Owner terminal has valid dimensions. Child terminals therefore proxy the captured Owner renderer terminal and reject invalid explicit resize values instead of treating zero as usable.
- Pi may persist an auto-detected theme during `InteractiveMode.init()`. `SettingsManager.save()` rebuilds effective settings and drops process-local overrides, so coordination retry/compaction/transport policy must be reasserted after child mode initialization and before model admission.
- Selector dismissal itself is synchronous, but target preparation can be asynchronous. Preparing while the selector still owns focus removes the Owner-input leak without inventing a second focus manager.
- Agent-to-Agent switching must retarget the existing durable attachment. Mounting a new surface through the old child's extension UI would attach it to the wrong renderer.
- `InteractiveMode.init()` starts extension UI before `session_start` settles. An initializing projection must therefore be publishable before its readiness promise resolves, or a startup dialog deadlocks behind the Run lane.
- Pi child modes normally register `SIGTERM`, `SIGHUP`, and `uncaughtException` handlers and route interactive quit through process exit. Embedded modes must replace those seams before `init()` and emit their own exact extension shutdown during Run-owned disposal.
- Pi's themes, registered themes, theme callback, keybindings, and model registry refresh are process-global even when sessions are independent. Child construction and service refresh require serialization and restoration of incidental initialization mutations. Explicit theme configuration remains shared Workflow-wide.

# Outcomes & Retrospective

Every exact live Agent and Moderator Run now owns one complete embedded Pi mode without rebinding the Owner. Durable `/agents` attachment preserves native fullscreen rendering and input across live, Dormant, failure, successor, Owner-return, and Agent-to-Agent transitions. Embedded lifecycle and process-global resources are isolated, startup UI remains reachable before model admission, and exact Run/view resources clean up once.

Automated validation passes, including real fullscreen Owner PTYs for long streaming transcripts, scrolling, scrollbar drag, resize, startup/Run/render/input failure, switching, disposal, and exact Owner restoration. Human fullscreen retest confirms mouse scrolling. Independent review found no remaining Critical or High defect. Its shared-theme restoration finding is fixed with two real projection regressions. A later closure review found one Medium constructor-failure footer watcher leak; watcher startup is now deferred until the mode is reachable and covered by a real process-resource rollback/recovery test. The complete issue-by-issue evidence matrix is recorded in `docs/agent-view-acceptance.md`. Final post-fix regression, conformance, typecheck, package, audit, and diff-hygiene gates pass. The independent constructor follow-up reports no remaining finding and marks #63, #64, and #68 ready; combined with the closure review, #63–#68 all pass their acceptance criteria.
