# Remove private interactive host capture

## Goal

Remove every remaining access to Pi's private `InteractiveMode.bindCurrentSessionExtensions`, `InteractiveMode.runtimeHost`, and `InteractiveMode.ui` members while preserving native Owner Runtime borrowing, child PTY presentation reinitialization, exact child input lifecycle admission, `/reload`, and failed-admission cleanup.

## Intention

Keep Pi's stock CLI as the composition root, but observe it only through public interfaces. Public method interception is acceptable because Pi exposes no first-class current-Runtime hook and the project does not equate monkey-patching with private access.

## Scope & Constraints

- Capture the CLI-owned `AgentSessionRuntime` by observing public `AgentSessionRuntime.setRebindSession` registration, then validate it before public TUI `AgentSession.bindExtensions` admission.
- Capture the stable public `TUI` through an invisible zero-line `ExtensionUIContext.setWidget` factory; use public `TUI.stop`, `start`, and `requestRender` for reinitialization.
- Preserve exact child editor submission ordering by keeping the public `InteractiveMode.getUserInput` wrapper and injecting the already captured child `AgentSession`; never read private `runtimeHost`.
- Preserve the one-child-process/one-interactive-loop invariant explicitly.
- Remove private InteractiveMode host-shape checks instead of retaining legacy rejection logic.
- Do not replace the Pi CLI with an SDK-owned composition root.
- Do not weaken input tracking to the later public `input` extension event.

## Test Seams

The agreed observable seams are:

1. `InteractiveHostBridge.capture(sessionManager, ui)` admits the exact public Runtime and presentation without private InteractiveMode members and remains idempotent across extension reload.
2. A child presentation can be reinitialized through the public TUI received by `ExtensionUIContext.setWidget`, without adding visible content.
3. Process-backed PTY input remains active until the exact public `AgentSession.prompt` started by that editor submission settles or starts the Agent Run.
4. Existing real Pi Owner/child conformance remains unchanged across startup, `/reload`, view attachment, Run failure, and shutdown.

## Work Plan

1. Add a failing host-bridge regression that supplies no private InteractiveMode members and captures the Runtime through public Runtime-host registration.
2. Replace the private binding patch with an idempotent public `AgentSessionRuntime.setRebindSession` observer.
3. Add a failing presentation regression for public zero-line widget TUI capture and make reinitialization use that TUI.
4. Add a failing input-lifecycle regression proving child observation does not require `InteractiveMode.runtimeHost`; inject the captured session into the public `getUserInput` wrapper.
5. Delete private InteractiveMode instance checks and update conformance fixtures.
6. Run targeted host-shape, child Runtime, process Runtime, Owner workflow, projection lifecycle, `/reload`, and full fast suites.
7. Review the diff for remaining private InteractiveMode references, then archive this plan.

## Validation

- `npm run typecheck`
- `npm run test:fast`
- `tests/host-shape.test.ts`
- `tests/interactive-host-conformance.test.ts`
- `tests/pi-child-process-runtime.test.ts`
- `tests/pi-child-hosted-runtime.test.ts`
- `tests/admitted-pi-child-process-projection.test.ts`
- Owner bootstrap/workflow and Run projection lifecycle suites
- `rg` confirms no production references to private `bindCurrentSessionExtensions`, `runtimeHost`, or `InteractiveMode.ui`.

## Progress

- [x] Confirmed Pi 0.84 lacks first-class Runtime, TUI lifecycle, and exact editor-submission hooks in the extension interface.
- [x] Confirmed extension factories load before `InteractiveMode` calls public `AgentSessionRuntime.setRebindSession`.
- [x] Confirmed public widget factories receive Pi's stable public TUI and an empty above-editor widget does not add a row beyond the container's existing spacer.
- [x] Replaced Runtime capture with public Runtime registration plus public TUI session-binding validation.
- [x] Replaced presentation capture with a zero-line public widget TUI.
- [x] Replaced the private input-session lookup with the captured child session.
- [x] Removed private InteractiveMode host-shape checks.
- [x] Completed targeted validation, review/fix loops, and private-reference audit.

## Decisions

- Prefer narrow public interception over rebuilding Pi's CLI composition root.
- Keep exact input observation; the public `input` event is not equivalent because extension commands and earlier preflight work occur outside it.
- Treat Runtime capture, presentation capture, and input observation as separate modules with small interfaces rather than one shallow InteractiveMode adapter.

## Surprises & Discoveries

- Pi calls `setRebindSession` once and later passes each replacement `AgentSession` through the registered callback, so the bridge publishes the replacement `SessionManager` before delegation.
- Runtime validation cannot run on every observed setter call because headless modes use the same public Runtime method. Public `AgentSession.bindExtensions({ mode: "tui" })` is the fail-fast admission seam: it validates before `session_start`, so Pi cannot swallow structural failure as an extension-handler error.
- Native session replacement still needs a forced redraw after the public rebind callback completes. Both Owner and child now register the public TUI obtained through their zero-line widget capture, allowing the Runtime bridge to request that post-rebind full render without an InteractiveMode field.
- Failed TUI admission must restore both public prototype patches and the native rebind callback already stored on the exact Runtime instance; restoring prototypes alone leaves a stale coordination closure active during later native replacement.
- Process-global input patch state must publish only after prototype assignment succeeds; otherwise a failed installation poisons later reload/retry attempts.
- The complete process suite remains blocked by pre-existing PTY fixtures whose manually managed Owner uses an in-process-only deterministic model; the child CLI exits because that provider is unavailable. The same detached-child failure reproduced from clean `da1a043`. Targeted real child Runtime and interactive-host suites pass.

## Outcomes & Retrospective

- Production no longer references private `InteractiveMode.bindCurrentSessionExtensions`, `InteractiveMode.runtimeHost`, or `InteractiveMode.ui`.
- The host bridge now observes public Runtime registration, validates public TUI session binding before `session_start`, and restores both prototype and instance callback state on failed admission.
- Owner and child presentation capture use Pi's public stable TUI reference through a zero-line widget, including the required post-replacement forced redraw.
- Exact child input observation retains the public `getUserInput` patch but receives its public `AgentSession` explicitly and can recover from failed patch installation.
- Typecheck, the full fast suite, real Pi child Runtime tests, interactive-host conformance, Owner bootstrap/workflow/fork tests, and Run projection lifecycle tests pass.
