# Interactive Herdr Agent Run control prototype

> **Throwaway prototype.** This branch is primary evidence for the Wayfinder decision [Prove Herdr Agent Run admission and termination](https://github.com/ewgdg/pi-agent-coordination/issues/17). It is not an implementation base.

## Question

Can a normal interactive Pi TUI remain fully human-operable while a machine controls the same Pi process reliably—without RPC mode, a second writer, a replacement UI, or typing commands into Pi’s editor?

## Shape

```text
Herdr pane PTY ───────────────→ normal Pi TUI      # human input and Human Answers
Python driver ── AF_UNIX ─────→ Pi extension       # submit, steer, abort, Human Request, shutdown
       │                              │
       │ redirect =                   ├─ pi.sendUserMessage()
       │ abort → settle → submit      ├─ ctx.abort()
       │                              ├─ ctx.ui.input()
       └──────────────────────────────└─ ctx.shutdown()
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
5. While that work is active, press `s`: Pi accepts non-interrupting steer for its next turn boundary; the current tool call must continue.
6. Type an unsent draft into Pi’s editor while active work runs, then press `x`: `ctx.abort()` must settle work while Pi remains alive. If no steer is pending, the draft remains unchanged. If a steer is still pending, Pi natively restores it ahead of the draft.
7. Press `w` again, then `r`: redirect performs abort → confirmed settlement with the admitted Pi PID still present → submit replacement guidance.
8. With unsent editor text while idle, press `k`: the socket schedules `ctx.shutdown()` without typing or clearing a shutdown command in the editor.
9. Press `q`: explicitly close the scratch pane and soft-delete the disposable scratch directory and fail-closed lease.

Also test shutdown while a Human Request is blocked. The extension cancels its own `ctx.ui.input()` through an `AbortController`, clears Herdr’s `blocked` projection, and then requests graceful Pi shutdown.

## Control protocol

One authenticated NDJSON request is allowed per connection:

```json
{"version":1,"id":"uuid","token":"64-hex","op":"probe|submit|steer|abort|request_human|shutdown","text":"optional"}
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

An `accepted` response means only that the request was authenticated, validated, and dispatched or scheduled through Pi’s public APIs. The public extension API does not provide queue or delivery confirmation for steer, settlement confirmation for abort, or `agent_start` confirmation for submit. Settlement is observed separately through `agent_settled`, an idle probe, and Herdr’s settled `idle` or `done` status. Shutdown sets the runtime closing state before acknowledgment, so no later controls are admitted, but acknowledgment and socket closure are not process-exit receipts.

| Operation | Admission | Meaning after acceptance |
| --- | --- | --- |
| `submit` | Idle, unblocked Run | Pi has accepted dispatch of new work; `agent_start` remains a separate observation. |
| `steer` | Confirmed active work | Pi has accepted non-interrupting guidance for its next turn boundary; the current turn/tool batch continues. |
| `abort` | Confirmed active work | Pi has received an interruption request; settlement remains a separate observation. |
| redirect | Driver-only composition | Abort accepted → settlement and admitted-PID presence observed → replacement submit accepted. |

Redirect is intentionally absent from the wire protocol. It is a driver-level composition over `abort`, independent settlement observation, and `submit`; it does not replace steer.

Pi’s interactive abort natively restores any unconsumed queued steer into the TUI editor ahead of the human’s unsent draft. An abort or redirect after steer can therefore expose the pending guidance in the editor. This is expected Pi behavior: steer remains useful when guidance should wait for the next turn, while redirect is the explicit interrupt-and-replace operation.

## Result boundary

The prototype can prove:

- one normal human-operable Pi TUI remains the Agent Run;
- a second cooperating executable admission for the same session is rejected before Pi spawn;
- socket, Herdr, and lease bind the same Pi process and session;
- machine controls do not depend on editor contents, Vim mode, dialogs, or terminal focus;
- Human Requests use Pi’s real panel;
- submit, steer, abort, Human Request, and shutdown call Pi’s extension APIs in the existing process;
- steer queues guidance without interrupting current work;
- semantic redirect remains distinct and composes abort, independently confirmed settlement with the admitted PID still present, and submit;
- abort settles work without injecting an abort command or terminating Pi; pending steer restoration remains Pi-owned editor behavior;
- required Agent environment can be forwarded explicitly;
- session replacement is refused while the lease identifies the current session.

It still cannot prove through the selected portable surface:

- an independently waitable handle for the exact Pi process incarnation;
- Pi’s exit code or terminating signal;
- safe automatic lease release gated by exact-incarnation exit;
- an async preflight completion/failure receipt from `pi.sendUserMessage()`. Submit reserves `starting` before dispatch, but if Pi rejects before `agent_start`, control remains fail-closed until extension reload rather than risking a late duplicate start.

The lease therefore remains fail-closed through abort, reload, shutdown acknowledgment, socket closure, observed Pi disappearance, EOF, exceptions, and interrupted launch. Only the explicit `q` action removes the disposable lease and scratch state; abnormal driver exit prints their locations for manual inspection. Automatic Idle-close remains a downstream policy decision.

The bearer token prevents accidental cross-run control and, with directory permissions, other local users. It does not defend against malicious code running as the same OS user or root; that requires a stronger isolation boundary, not a different prototype token.
