# Interactive Agent view acceptance matrix

This matrix records the production process-backed Agent-view contract and its regression evidence.

## Production paths

- `src/process-runtime/pi-child-process-runtime.ts` — exact Pi CLI process, PTY, Control admission, transcript handoff, and process-group cleanup.
- `src/process-runtime/pty-terminal-projection.ts` — ANSI terminal state, cursor, generated replies, input, resize, and exact exit.
- `src/process-runtime/pi-child-hosted-runtime.ts` — process-neutral Run intentions and lifecycle settlement.
- `src/process-runtime/child-runtime-bridge.ts` — truthful child TUI binding, lifecycle reporting, coordination tools, activity dock, and `/agents` registration.
- `src/process-runtime/remote-agent-selector.ts` — scoped selector snapshots and awaited Owner selection actions.
- `src/presentation/agent-view-surface.ts` — full-window projection, prioritized physical input, failure handling, and Owner restoration.
- `src/coordination/durable-agent-view.ts` — one retargetable Workflow attachment.
- `src/coordination/workflow-coordinator.ts` — view authority, retention, retargeting, Human Attention focus, and shutdown.

## Process and terminal isolation

| Contract | Evidence |
|---|---|
| Every non-Owner Runtime is a distinct Pi CLI process | `tests/process-child-session-factory.test.ts`, `tests/pi-child-process-runtime.test.ts` |
| Child context is real TUI/UI | process Runtime handshake tests require `mode: "tui"` and `hasUI: true` |
| Child extensions cannot mutate Owner globals | Moderator theme isolation and Agent-view process probes |
| Physical Herdr pane ownership remains Owner-only | child environment tests and the real Herdr Owner → child → Owner gate |
| One process writes a live child transcript | transcript materialization, fresh-file inspection, successor, and cold-recovery tests |
| Process group, socket, bootstrap, context, and PTY cleanup are exact | process Runtime, launch cancellation, shutdown, and descendant cleanup tests |

## Complete child UI

| Contract | Evidence |
|---|---|
| Child editor, footer, status, widgets, notifications, commands, shortcuts, dialogs, and overlays remain native | `tests/agent-view.test.ts` file-backed process probes |
| Long transcript navigation, mouse input, streaming, and reflow work through a real PTY | `tests/coordinated-workflow-pty.test.ts` |
| Input bytes, generated terminal replies, cursor, styles, wide cells, and resize remain separate and exact | PTY Terminal Projection tests |
| Startup dialogs are visible before Runtime admission | Agent-view startup modal and process launch tests |
| Child input/render/initialization/process failures restore the Owner or retain the failed view according to Run state | Agent-view unit and fullscreen failure PTYs |
| Closing a pending view cannot orphan a hidden startup UI process | Dormant startup cancellation and Workflow shutdown tests |

## Durable `/agents` navigation

| Contract | Evidence |
|---|---|
| Owner and process children render the complete scoped selector | selector surface and remote selector snapshot tests |
| Selecting Owner closes only the attachment and keeps retained child work alive | fullscreen return and interactive host conformance tests |
| Selecting another child retargets one attachment | independent process-child switch tests and fullscreen PTY switch |
| Input and resize continue after retarget | complete-frame/input and 100×30 PTY cases |
| Selecting the same child is safe; cancellation preserves selection | remote selector domain tests |
| Stale Human Attention or focus failure restores the previous Agent | `tests/remote-agent-selector.test.ts` |
| Escape remains native child input | custom editor and overlay tests |
| Activity and Attention update while the selector is open | Control snapshot/change events and activity dock tests |

## Runtime and Run ownership

| Contract | Evidence |
|---|---|
| Agent Identity and one immutable Runtime Blueprint commit before process launch | spawn, transcript, and process factory tests |
| Dormant selection can prepare a Runtime without inventing model work | cold-recovery and Dormant Agent-view tests |
| Extension, editor, command, Message, and `session_start` input activate exact Runs normally | Agent-view activation tests |
| `agent_settled` is authoritative; prompt acceptance is not settlement | hosted Runtime lifecycle and retry tests |
| Selected failure, termination, interruption, and Workflow shutdown preserve exact Run identity | Runtime supervisor and process fault tests |
| Successor and cold Runtimes reuse the committed blueprint | process factory, successor, and cold discovery tests |
| Nested spawning uses the admitted parent Runtime snapshot and committed skill sources | nested parent snapshot tests and fullscreen nested-child flow |

## Release gates

The acceptance matrix is complete only when these commands pass:

```text
npm run typecheck
npm test
npm run test:conformance
npm pack --dry-run
npm audit --omit=dev
git diff --check
```

The real integration gate starts a Herdr-managed Pi Owner, delegates to a process child, waits for the child's Answer, confirms the final session reference remains the Owner session, confirms Herdr reaches `done` or underlying `idle`, and verifies no child process or transient Runtime artifact remains.
