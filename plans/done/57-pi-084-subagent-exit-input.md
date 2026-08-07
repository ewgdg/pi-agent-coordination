# Goal

Restore reliable terminal input and exact selected-session lifecycle when a subagent exits under Pi 0.84.0.

# Intention

Separate the extension-owned selected-session transition from the Pi/TUI terminal-parser failure. Prove the user-visible failure at the narrowest public seams, fix only behavior this package owns, and document any remaining upstream boundary precisely.

# Scope & Constraints

- Treat Pi 0.84.0 as the active development cohort.
- Preserve unrelated work already present in the worktree.
- Test observable interactive behavior and public host seams.
- Do not modify `node_modules` or silently add a bundled Pi runtime.
- Do not add compatibility handling for obsolete Pi versions.

# Work Plan

1. Reproduce the malformed Kitty CSI-u input and the 0.84 selected-session failure.
2. Inspect Pi 0.84 abort, agent-end, TUI input, and session-rebind ordering.
3. Add a red regression test at the correct extension/public seam.
4. Implement the smallest extension-owned fix; isolate any unavoidable Pi/TUI workaround.
5. Remove probes and update relevant documentation.
6. Run focused tests, typecheck, full conformance, package, and diff checks.

# Validation

- `StdinBuffer` malformed split reproducer demonstrates the upstream parser boundary.
- Human-request and interactive conformance tests pass on Pi 0.84.0.
- PTY coordinated-workflow test passes repeatedly.
- `npm test`, `npm run typecheck`, `npm run test:conformance`, `npm pack --dry-run`, and `git diff --check` pass.

# Progress

- 2026-08-06: Confirmed repository dev dependencies were stale at 0.83.0 and updated all Pi host packages to 0.84.0.
- 2026-08-06: Confirmed Pi/TUI 0.84 uses a 10 ms `StdinBuffer` timeout and that an Escape sequence split beyond that timeout becomes a literal CSI-u tail.
- 2026-08-06: Added a red-capable PTY regression for native Escape from a selected subagent and a focused Run-supervision regression for Pi's abort-reported error.
- 2026-08-06: Fixed the extension-owned lifecycle boundary by intercepting external `Agent.abort()` calls, arming the exact Run for interruption, and establishing the Hold through the serialized host lane.
- 2026-08-06: Narrowed the lockfile update to Pi 0.84.0 and its required package additions; restored incidental AWS SDK, `ws`, and `brace-expansion` refreshes.
- 2026-08-06: Updated a stale cold-recovery UI assertion to avoid assuming which recency-sorted Dormant Agent receives initial focus.

# Surprises & Discoveries

Pi/TUI's `onTerminalInput` extension seam is downstream of `StdinBuffer`; it can transform already-emitted input but cannot prevent the parser's initial timeout. A workaround must therefore be narrowly scoped and cannot replace an upstream parser correction.

# Decisions

The extension owns Run lifecycle after Pi has parsed terminal input. It can repair the direct abort path and exact-Run transition, but it cannot prevent Pi/TUI's upstream `StdinBuffer` timeout from emitting a malformed CSI-u tail.

# Outcomes & Retrospective

The extension-owned bug is fixed and validated on Pi 0.84.0. Native Escape now leaves the selected subagent in a retryable interruption Hold instead of entering an unusable execute state or prematurely fencing the Run. The upstream parser boundary remains separately identified and is not silently worked around in this package.

Validation completed:

- focused PTY and Run-supervision tests: 17/17;
- full suite: 220/220;
- conformance suite: 65/65;
- TypeScript typecheck;
- `npm ci --dry-run`, `npm pack --dry-run`, `npm audit --omit=dev`, and `git diff --check`.
