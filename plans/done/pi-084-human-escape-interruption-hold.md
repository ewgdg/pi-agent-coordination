# Goal

Keep an interactively selected Agent's exact Run available in an Interruption Hold when the human presses Escape during an open Human Request on Pi 0.84.

# Intention

Bind Human Escape to the open Human Request and the Agent that owns Interactive Selection. Preserve Pi's native input handling while starting the existing exact-Run interruption path before Pi reports the abort as a terminal model error.

# Scope & Constraints

- Treat Pi 0.84.0 as the active development host.
- Preserve Human Escape and authorized supervisor interruption as independent ways to establish the same exact-Run Hold.
- Do not intercept unrelated `Agent.abort()` calls.
- Do not consume, transform, delay, or parse terminal input.
- Keep concurrent background Human Requests isolated by Agent identity and Interactive Selection.

# Work Plan

1. Reproduce selected-child Human Escape through the coordinated PTY.
2. Add public-seam coverage distinguishing Human Escape from unrelated Agent aborts.
3. Route Escape through the open request whose Agent owns Interactive Selection.
4. Keep exact-Run error classification armed until the serialized Hold transition settles.
5. Run focused Human Request and supervision tests, conformance, the full suite, and package checks.

# Validation

- The coordinated PTY shows the selected Agent as `held` after Human Escape.
- An unrelated direct `Agent.abort()` does not preempt a later explicit interruption.
- Focused and passive Human Request Escape paths pass without consuming the native key.
- `npm test`, `npm run typecheck`, and `npm run test:conformance` pass.
- `npm ci --dry-run`, `npm pack --dry-run`, `npm audit --omit=dev`, and `git diff --check` pass.

# Progress

- 2026-08-06: Updated the development host packages from Pi 0.83.0 to 0.84.0.
- 2026-08-06: Added a coordinated PTY assertion for the selected Agent's exact `held` state after Human Escape.
- 2026-08-06: Added a regression proving unrelated direct Agent aborts do not manufacture a Hold.
- 2026-08-06: Bound raw Escape only while Human Requests are open; a focused request wins, otherwise only the request owned by the interactively selected Agent is interrupted.
- 2026-08-06: Removed Run-wide `Agent.abort()` interception and kept the existing serialized interruption path as the sole Hold transition.
- 2026-08-06: Passed focused Human Request and supervision tests, the full suite, 66 conformance tests, typecheck, package/install dry-runs, production audit, and diff checks.

# Surprises & Discoveries

A selected child's Human Request remains passive rather than opening its custom surface. Escape therefore reaches Pi's selected native Agent session without passing through the request component. The request presentation must observe raw input while requests are open and resolve the target from focused request ownership or Interactive Selection.

# Decisions

Human Request presentation observes Escape but never consumes or rewrites it. It invokes the existing interruption callback for exactly one request: the focused request, or otherwise the open request owned by the selected Agent. Programmatic Agent abort remains ordinary runtime behavior.

# Outcomes & Retrospective

Human Escape now establishes the same exact-Run Interruption Hold as explicit supervision without globally changing Agent abort semantics. The regression covers the real native PTY ordering and remains terminal-independent.
