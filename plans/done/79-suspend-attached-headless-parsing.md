# Goal

Remove `@xterm/headless` parsing from the steady-state physical child path while preserving a correct detached frame and one terminal-query responder across every attachment transition.

# Intention

Let the selected child PTY route raw output directly to the physical terminal. When physical ownership ends, rebuild headless state from one complete native Pi render instead of retaining or replaying attached output.

# Scope and constraints

- Keep `node-pty` and the existing physical stdout backpressure path.
- Keep headless xterm authoritative while detached and in non-TTY hosts.
- Replace the boolean attachment interface if needed. Do not add compatibility aliases.
- Do not expose stale or partial detached frames.
- Cover Owner to child to Owner, child to child, failure, exit, and burst output with focused tests. Avoid the full process suite until targeted validation passes.

# Work plan

1. Add failing PTY tests proving attached output bypasses headless parsing and detach rebuilds the frame from a complete redraw.
2. Add failing physical attachment adapter tests for asynchronous detach reconstruction and direct child-to-child retargeting.
3. Deepen the physical child terminal interface around explicit attach and detach transitions rather than a state boolean.
4. Implement the projection state machine: drain before attach, skip attached parser writes, reset stale headless state on detach, parse the native redraw, and wait for it to settle.
5. Update runtime and Pi presentation adapters so the redraw is synchronous at its source and observable as complete by the projection.
6. Add a focused burst benchmark or structural trace showing zero headless parser publications while attached.
7. Run targeted tests, typecheck, then the fast suite if the blast radius warrants it.

# Validation

- `node --test tests/pty-terminal-projection.test.ts`
- `node --test tests/agent-view-surface.test.ts`
- relevant real PTY cases from `tests/coordinated-workflow-pty.test.ts`
- `npm run typecheck`
- `npm run test:fast` only after targeted tests pass

# Progress

- [x] Reviewed current projection, physical attachment, runtime adapter, Pi TUI render scheduling, and existing tests.
- [x] Confirmed an ANSI-heavy isolated xterm benchmark has material parser cost.
- [x] Failing tests added.
- [x] Projection and attachment transitions implemented.
- [x] Targeted validation passing.
- [x] Outcome recorded and plan moved to done.

# Surprises and discoveries

- Raw physical handlers already run before `terminal.write`, so the expected win is reduced Owner event-loop contention rather than lower first-chunk routing latency.
- `TUI.requestRender(true)` schedules work on `nextTick`; it does not make a control response a redraw-completion barrier. `TUI.renderNow(true)` is public and renders synchronously.
- `Terminal.reset()` does not clear xterm's internal queued write buffer. Attach must drain existing parser writes before later reset.
- A static redraw marker can be consumed by an older attach redraw during concurrent close or retarget. Each redraw now carries a unique marker through Control protocol version 4.
- Retargeting must await physical stdout drain before it begins the replacement attachment. Owner restoration can start immediately because accepted bytes and Owner writes share the same ordered stdout stream.

# Decisions

- Treat attachment and detached reconstruction as lifecycle operations, not a boolean setter.
- Require a measured structural signal. Steady attached output must not produce headless change publications.
- Drop physical input until a replacement child has completed native reinitialization. Its terminal queries are still safe because redraw output stays queued and is not published to the physical terminal until input buffering is active.

# Outcomes and retrospective

- The steady attached path now publishes raw PTY output without calling `terminal.write` or emitting headless frame changes.
- Detach resets stale emulator state, requests one synchronous native Pi render, and waits for its uniquely marked in-band completion before publishing the rebuilt frame.
- Physical stdout backpressure, immediate projection failure, Owner restoration, repeated attachment, and child-to-child retargeting have focused coverage.
- `npm run benchmark:attached-terminal` measured 150,000 ANSI frame updates at roughly 1,150 ms with headless parsing and 97 ms through the physical bypass on this run, about 11.8x throughput. This is a deliberately parser-heavy burst, not an estimate of normal interactive latency.
- Typecheck and all focused projection, attachment, protocol, host-shape, process-runtime, and real PTY lifecycle tests pass. The fast suite passes every product test but its existing `run-test-suite.test.ts` process-supervisor meta-test exceeds its own 5-second limit by about 1 ms on this machine.
