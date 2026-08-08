# Pi-native non-Owner Run projections

## Goal

Give every exact live ordinary-child and Moderator Run its own real Pi `InteractiveMode` presentation projection, and provide the same read-only projection seam for Dormant transcript inspection, without rebinding or otherwise changing the Owner runtime.

## Intention

Treat Pi-native presentation as a Run-owned resource. Construct it after the Run session has bound extensions and before the session is returned for message admission. Keep all private `InteractiveMode` access in one Pi-integration adapter. Dispose projection resources before their exact session on every Run end path. Dormant projection sessions remain passive and independently owned.

## Scope & constraints

- Start from `main`; do not merge or copy the prototype command, overlay, selected-session accessor, shadow host, or swap-first fixtures.
- Overlay attachment is absent.
- Use a real `InteractiveMode`; expose only transcript and Run-status `Component`s plus idempotent disposal.
- Keep the Owner `AgentSessionRuntime`, global theme, and global keybinding binding unchanged.
- Continue to support the current native Interactive Selection until its separate removal ticket.
- Test observable rendering and lifecycle ownership against real Pi sessions; use fakes only to force cleanup failures or count exact ownership.

## Work plan

1. Add failing projection adapter tests for native transcript reconstruction, live working status, Dormant passivity, Owner global/runtime isolation, and compatibility failure cleanup.
2. Add failing Run-host lifecycle tests for clean release, startup rollback, failure, termination, shutdown, and idempotent projection disposal.
3. Implement the focused Pi adapter around a detached `AgentSessionRuntime` and real `InteractiveMode`, with a no-output terminal, mechanical shape guards, and global presentation-state restoration.
4. Change child/Moderator session startup to return a session-plus-projection resource, and make `InProcessAgentHost` own/dispose both.
5. Build Dormant presentation bindings through the same projection host while preserving their independent selection-owned lifetime.
6. Wire the projection host from the captured Owner InteractiveMode; keep a default host for direct SDK/test coordinator construction.
7. Run targeted tests, typecheck, full tests, conformance, package dry run, and diff hygiene.

## Validation

- `npm run typecheck`
- targeted native projection and lifecycle tests
- `npm test`
- `npm run test:conformance`
- `npm pack --dry-run`
- production dependency audit and `git diff --check`

## Progress

- [x] Confirmed issue requirements and started `feat/64-run-projections` from current `main`.
- [x] Inspected Pi 0.84 `InteractiveMode`, runtime, renderer, footer, theme, and keybinding ownership seams.
- [x] Added red-first adapter and exact-Run lifecycle tests.
- [x] Implemented the native projection adapter, live/Dormant construction, and exact ownership.
- [x] Verified ordinary-child/Moderator parity through real-session projection rendering.
- [x] Closed review findings with real-session regressions for `session_start` model admission and termination settlement ordering.
- [x] Full regression, conformance, typecheck, package dry run, and dependency audit are green.

## Surprises & discoveries

- `InteractiveMode` construction allocates the footer watcher, editor, renderer, keybindings, and theme controller before `init()`. Its event handler calls `init()` unless the adapter marks the detached mode initialized, so the adapter must prevent native terminal startup explicitly.
- Construction mutates process-global theme registration/theme state and TUI keybindings. The adapter must restore those synchronously before yielding, while retaining the projection's instance-local renderer/editor/keybinding resources.
- `InteractiveMode.stop()` disposes footer and status resources but does not dispose its `AgentSessionRuntime`; this matches exact Run ownership because the Run host remains the sole session disposer.
- Pi extension binding emits `session_start`, whose handlers can schedule `_runAgentPrompt()` without awaiting it. Live startup therefore needs an admission gate at the model Run entry point until projection subscription completes.
- Aborting a live Pi session emits final `agent_end` and `agent_settled` events. Projection disposal belongs after that settlement, not before abort.

## Decisions

- Use a real `InteractiveMode` with a real `TuiMainScreen` backed by a no-output `Terminal`, not a prototype shadow host.
- Expose native transcript and status containers as the stable component seam; do not expose the mode, detached runtime, editor, footer, or TUI.
- Keep live projections synchronous to dispose and idempotent. Let the Run host aggregate projection/session cleanup failures.
- A Dormant binding owns both its passive session and projection and releases both independently from any live Run.

## Outcomes & retrospective

- Live ordinary-child and Moderator Runs now receive one real native projection before their session can be admitted for work.
- The Run host owns projection and session as one exact resource pair across clean release, failure, termination, startup rollback, and Workflow shutdown.
- Dormant selection bindings own an independent passive session and projection with no active tools or exposed input seam.
- Private Pi coupling is local to `native-agent-projection.ts` and guarded by module/instance conformance tests against Pi 0.84.
- Projection construction retains Pi's renderer/editor/footer allocations while replacing only the renderer terminal with a no-output implementation. The unused footer git watcher is closed immediately; all remaining native resources stop with the projection.
- The full suite exposed one shared-faux-model fixture whose response order depended on Run timing. Routing that fixture by transcript and role made the intended behavior deterministic under real projection rendering.
