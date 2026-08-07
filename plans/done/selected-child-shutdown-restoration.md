# Goal

Make double-Ctrl-C shutdown from a selected child exit through the same terminal lifecycle as Owner-selected shutdown, without added delay.

# Intention

Pi owns terminal draining and stops the TUI before it calls runtime disposal. Coordination teardown restores the Owner session required by native disposal without running an interactive session rebind after that stop boundary.

# Scope & Constraints

- Treat Pi 0.84.0 as the active host boundary.
- Keep selected-child Human Escape interruption as a separate behavior.
- Do not add terminal-brand, keyboard-protocol, or escape-sequence handling.
- Do not extend Pi's native drain interval or add another shutdown timer.
- Do not modify installed dependencies.

# Work Plan

1. Capture the Owner-selected and selected-child shutdown control-flow difference.
2. Add a red public-seam regression for post-stop interactive rebinding.
3. Remove the terminal input quarantine and its synthetic delayed-response coverage.
4. Restore only Owner runtime state during coordinated shutdown, then use the existing exhaustive child and Owner disposal path.
5. Run focused, conformance, full-suite, package, audit, and diff validation.
6. Confirm the result with the user's exact command and double-Ctrl-C sequence.

# Validation

- The selected-child shutdown regression observes zero post-stop interactive rebinds and native disposal sees the Owner session.
- Existing selected-session, exact-disposal, and PTY lifecycle tests pass.
- `npm test`, `npm run typecheck`, and `npm run test:conformance` pass.
- `npm ci --dry-run`, `npm pack --dry-run`, `npm audit --omit=dev`, and `git diff --check` pass.
- Live double-Ctrl-C shutdown no longer returns `CSI ? 62;22c` to the parent shell.

# Progress

- 2026-08-06: Confirmed Pi's interactive shutdown order is input drain, TUI stop, then runtime disposal.
- 2026-08-06: Confirmed Owner-selected shutdown skips session restoration while selected-child shutdown used the ordinary interactive Owner-selection path.
- 2026-08-06: Added a regression that failed because selected-child shutdown invoked the interactive rebind once; Owner-equivalent behavior requires zero calls.
- 2026-08-06: Removed the one-second terminal drain wrapper and delayed terminal-response fixture.
- 2026-08-06: Added shutdown-only Owner runtime restoration with no UI callback, render, terminal parsing, or delay.
- 2026-08-06: Passed the focused Owner workflow, interactive host, and PTY checks; the full suite; 66 conformance tests; typecheck; package/install dry-runs; production audit; and diff checks.
- 2026-08-06: The user confirmed the exact selected-child double-Ctrl-C flow exits cleanly in a live terminal.

# Surprises & Discoveries

The Owner/child difference is downstream coordination behavior, not a different Pi Ctrl-C handler. A selected child changes the shared runtime's current session, and coordinated disposal previously restored the Owner through the same full rebind used for a live human selection. That rebind ran only after Pi had stopped the TUI.

# Decisions

Shutdown separates disposal authority from presentation activation. The runtime session, services, and diagnostics return to the Owner so Pi disposes the correct native session, while stopped interactive UI remains untouched.

# Outcomes & Retrospective

Selected-child shutdown now follows the Owner-equivalent terminal lifecycle. It restores only the state required for native disposal, retains exhaustive child and Moderator cleanup, and adds no terminal-specific handling or delay. Automated and live-terminal validation both pass.
