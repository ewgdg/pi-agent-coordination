# Interactive Herdr Agent Run prototype

> **Throwaway prototype.** This branch is primary evidence for the Wayfinder decision [Prove Herdr Agent Run admission and termination](https://github.com/ewgdg/pi-agent-coordination/issues/17). It is not an implementation base.

## Question

Can a normal interactive Pi TUI in a Herdr pane enforce cooperating single-writer admission, prove its intended session binding, expose process/work/attention observations, host Human Requests, use Pi-native steer and abort, and terminate through Pi itself?

The prototype also tests whether Pi `0.82.1` and Herdr `0.7.5` can independently confirm the exact interactive Pi process incarnation exited without adding a custom process supervisor.

## Run

Requirements: Herdr `0.7.5`, Pi `0.82.1`, `trash-put`, and an active Herdr pane.

```bash
uv run --python /usr/bin/python prototypes/herdr-agent-run/prototype.py
```

Run this in a normal terminal, not through a non-interactive command capture. The driver creates another Herdr pane containing an ordinary Pi TUI. Human input remains in that Pi pane.

## Drive-through

1. Press `a`: the live lease rejects a second cooperating launch before another Pi writer is spawned.
2. Press `b`: compare the expected session with the session path reported by Pi's installed Herdr integration.
3. Press `i`: a real Human Request appears in the Pi panel and Herdr reports `blocked`. Answer it in the Pi panel, then press `p` to refresh.
4. Press `w`: submit normal Pi work and observe `working` without changing process presence or attention.
5. Press `s`: queue a steering message through Pi's extension API.
6. Press `x`: send Pi's native Escape abort and observe `idle` while Pi remains alive. The driver sends Escape twice so Vim INSERT mode cannot consume the abort key; existing editor text remains intact. Automatic Idle closure is downstream policy, not part of this prototype.
7. Press `k`: ask Pi to terminate itself gracefully. Herdr releases the Agent and Pi disappears from the pane's foreground process snapshot.
8. Press `q`: close the empty scratch pane and soft-delete the disposable scratch directory and fail-closed lease.

## Result boundary

The native interactive topology can prove:

- a normal human-operable Pi TUI remains the Agent Run;
- cooperating single-writer admission occurs before Pi spawn;
- Herdr readiness plus Pi's session report binds the intended session;
- work and attention observations remain distinct and may explicitly be `unknown` when Herdr's coarse status cannot prove both axes simultaneously;
- Human Requests use Pi's real panel;
- steering and abort use Pi semantics;
- abort settles work without terminating Pi;
- Pi can request its own graceful shutdown.

It cannot prove through the current native surface:

- an independently waitable handle for the exact normal-TUI Pi process incarnation;
- Pi's exit code or terminating signal;
- safe automatic lease release gated by exact-incarnation exit.

Herdr's `pane.process-info` can show that Pi is no longer observed and the shell regained the pane. Pi's integration can cooperatively release Agent status on a real quit. Neither is an exact process-exit receipt. The prototype therefore leaves the lease fail-closed until explicit human cleanup rather than inventing pidfd transfer, a custom socket, or a separate process supervisor.
