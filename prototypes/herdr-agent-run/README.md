# Interactive Herdr Agent Run control prototype

> **Throwaway prototype.** This branch is primary evidence for the Wayfinder decision [Prove Herdr Agent Run admission and termination](https://github.com/ewgdg/pi-agent-coordination/issues/17). It is not an implementation base.

## Question

Can a normal interactive Pi TUI remain fully human-operable while a machine controls the same Pi process reliably—without RPC mode, a second writer, a replacement UI, or typing commands into Pi’s editor?

## Shape

```text
Herdr pane PTY ───────────────→ normal Pi TUI      # human input and Human Answers
Python driver ── AF_UNIX ─────→ Pi extension       # submit, redirect, abort, shutdown
                                      │
                                      ├─ pi.sendUserMessage()
                                      ├─ ctx.abort()
                                      ├─ ctx.ui.input()
                                      └─ ctx.shutdown()
```

Pi RPC cannot attach to an already-running interactive TUI. Starting a second RPC Pi on the same session would violate single-writer ownership. The prototype instead gives the extension inside the existing Pi process a short authenticated POSIX pathname socket.

## Run

Requirements: Pi `0.82.1`, Herdr `0.7.5`, POSIX `AF_UNIX`, `trash-put`, and an active Herdr pane.

```bash
uv run --python /usr/bin/python prototypes/herdr-agent-run/prototype.py
```

Forward only environment variables the Agent requires:

```bash
uv run --python /usr/bin/python prototypes/herdr-agent-run/prototype.py \
  --forward-env REQUIRED_NAME \
  --forward-env ANOTHER_NAME
```

The launcher fails before spawning Pi if a requested variable is not exported. It does not copy the entire launcher environment implicitly. It writes a private Bash launch script using the absolute resolved Pi executable, equivalent to and stronger than `command pi`, so an interactive zsh `pi()` wrapper is never invoked.

## Drive-through

1. Press `a`: a second prototype executable targets the same session lease and is rejected before it can spawn Pi.
2. Press `b`: the authenticated probe, Herdr foreground process, Herdr session report, and lease must identify the same Pi Run.
3. Press `i`: the socket opens a real Human Request in Pi’s panel. Answer it only in that panel, then press `p`.
4. Press `w`: the socket submits deterministic long work through `pi.sendUserMessage()`.
5. Type an unsent draft into Pi’s editor while it works, then press `x`: `ctx.abort()` must settle work while Pi remains alive and the draft remains unchanged.
6. Press `w` again, then `s`: semantic redirect performs abort → confirmed settlement → submit new guidance. It does not place a pending Pi steering message in the editor.
7. With unsent editor text while idle, press `k`: the socket schedules `ctx.shutdown()` without typing or clearing a shutdown command in the editor.
8. Press `q`: explicitly close the scratch pane and soft-delete the disposable scratch directory and fail-closed lease.

Also test shutdown while a Human Request is blocked. The extension cancels its own `ctx.ui.input()` through an `AbortController`, clears Herdr’s `blocked` projection, and then requests graceful Pi shutdown.

## Control protocol

One authenticated NDJSON request is allowed per connection:

```json
{"version":1,"id":"uuid","token":"64-hex","op":"probe|submit|abort|request_human|shutdown","text":"optional"}
```

The extension:

- stores the socket under the private `0700` scratch directory;
- stores the per-session lease in a verified owner-only runtime/cache directory so separate executables contend on the same path;
- sets the socket and lease modes to `0600`;
- limits requests to 64 KiB;
- applies a short pre-request timeout;
- correlates every response by request ID;
- rejects invalid state, malformed requests, and incorrect tokens;
- reserves non-idle state before asynchronous submit dispatch, preventing duplicate submit or shutdown admission;
- blocks session switching and forking while the fixed-session lease is held;
- closes and rebinds the endpoint with a new runtime ID after extension reload.

An `accepted` response means only that the request was authenticated, validated, and dispatched or scheduled through Pi’s public APIs. Settlement is observed separately through `agent_settled` and Herdr’s settled `idle` or `done` status. Shutdown sets the runtime closing state before acknowledgment, so no later controls are admitted, but acknowledgment and socket closure are not process-exit receipts.

Semantic redirect deliberately composes abort → confirmed settlement → submit. It does not use Pi’s queued steering mode because Pi preserves an unconsumed steering message by restoring it into the TUI editor during native abort.

## Result boundary

The prototype can prove:

- one normal human-operable Pi TUI remains the Agent Run;
- a second cooperating executable admission for the same session is rejected before Pi spawn;
- socket, Herdr, and lease bind the same Pi process and session;
- machine controls do not depend on editor contents, Vim mode, dialogs, or terminal focus;
- Human Requests use Pi’s real panel;
- submit, abort, Human Request, and shutdown call Pi’s extension APIs in the existing process;
- semantic redirect composes abort, independently confirmed settlement, and submit;
- abort settles work without inserting control text or terminating Pi;
- required Agent environment can be forwarded explicitly;
- session replacement is refused while the lease identifies the current session.

It still cannot prove through the selected portable surface:

- an independently waitable handle for the exact Pi process incarnation;
- Pi’s exit code or terminating signal;
- safe automatic lease release gated by exact-incarnation exit;
- an async preflight completion/failure receipt from `pi.sendUserMessage()`. Submit reserves `starting` before dispatch, but if Pi rejects before `agent_start`, control remains fail-closed until extension reload rather than risking a late duplicate start.

The lease therefore remains fail-closed through abort, reload, shutdown acknowledgment, socket closure, observed Pi disappearance, EOF, exceptions, and interrupted launch. Only the explicit `q` action removes the disposable lease and scratch state; abnormal driver exit prints their locations for manual inspection. Automatic Idle-close remains a downstream policy decision.

The bearer token prevents accidental cross-run control and, with directory permissions, other local users. It does not defend against malicious code running as the same OS user or root; that requires a stronger isolation boundary, not a different prototype token.
