# Direct PTY Agent Attachment

## Goal

Keep every non-Owner Agent Runtime in its isolated Pi process while presenting the selected child through direct raw PTY attachment instead of continuously decoding its terminal and rebuilding Owner TUI components.

## Intention

The Owner remains the Workflow authority and the foreground Pi process in the Herdr pane. Selecting a child suspends only the Owner TUI, leases physical stdin/stdout/resize to the selected child PTY, and asks that child to reinitialize its native TUI so it emits its own terminal modes and a complete redraw. Returning to Owner releases the lease, restores the Owner TUI, and forces a full redraw. Child-to-child selection retargets the same Workflow-global physical attachment.

Headless xterm remains the detached terminal state keeper and startup diagnostic source. It is not the live renderer while a child owns physical attachment.

## Scope & Constraints

- Preserve process isolation, exact installed Pi CLI launch, Control, JSONL transcript ownership, and dynamic Runtime preparation.
- Preserve truthful child `mode=tui` and `hasUI=true`.
- Keep Workflow authority and physical attachment authority in Owner.
- Keep coordination modules unaware of PTY handles, stdin/stdout, ANSI framing, and transport request IDs.
- Do not put Owner behind a new node-pty or external launcher.
- Use Pi TUI `stop()`/`start()` through the presentation seam; do not modify Pi or Herdr.
- Child presentation reinitialization crosses structured Control. Raw input, output, and resize remain PTY traffic.
- Exactly one physical target owns input and output at a time.
- A child fault, exit, Control loss, cancelled initialization, or surface close restores Owner presentation.
- Do not preserve the component-rendered process-child overlay as a fallback after cutover.
- Keep Escape native child input.
- Selecting Owner navigates back without terminating retained child work.
- Five seconds remains a diagnostic guideline, not a blanket timeout.

## Confirmed Seam

The public test and caller seam is the Workflow-global physical attachment:

```ts
interface PhysicalTerminalAttachment {
  open(view: DurableAgentView): Promise<void>;
}
```

Its deep implementation owns Owner TUI suspension/resumption, raw physical terminal input, selected child PTY output, resize routing, atomic retargeting, terminal handoff, and failure restoration. The view supplies only the current process-backed terminal endpoint plus change/close/failure lifecycle.

Owner presentation and child PTY endpoints remain deliberately asymmetric. The Owner uses inherited physical stdin/stdout and an in-process TUI; children use Owner-created node-pty pairs and Control-backed presentation reinitialization.

## Work Plan

### 1. Establish direct-attachment endpoint

- Extend the process projection with a terminal attachment interface for raw output subscription, physical-attachment mode, presentation reinitialization, input, and resize.
- Forward raw PTY output from `node-pty` without exposing it to coordination modules.
- Suppress headless-xterm-generated replies while the physical terminal is the responder.

### 2. Add child presentation reinitialization

- Capture the child InteractiveMode TUI at the existing host bridge seam.
- Add a closed Control method that restarts that TUI presentation and forces a complete redraw.
- Keep this request separate from PTY bytes and Runtime lifecycle authority.

### 3. Implement physical terminal attachment

- Replace the live process-child overlay renderer with one attachment module.
- Suspend Owner TUI after the selector surface has completed.
- Serialize handoff, switch raw input/output ownership synchronously, buffer output and physical input until child presentation reinitialization completes, publish the ordered native state, and pause/resume child PTY output under physical-terminal backpressure.
- Retarget on `DurableAgentView` changes without briefly restoring Owner.
- Restore Owner exactly once on close, failure, exit, or setup failure.

### 4. Remove superseded rendering

- Delete process-child cell-to-component rendering from the live path.
- Remove style reconstruction and overlay-owned mouse-reporting logic that no longer has a caller.
- Retain xterm frame extraction only where detached diagnostics or one-time recovery require it; remove unused projection structures rather than retaining legacy paths.

### 5. Navigation and acceptance

- Preserve child-native `/agents` selection and child-to-child retargeting.
- Update Agent-view and child-UI docs to state direct physical attachment and native terminal-mode ownership.

## Validation

Work in vertical slices through the confirmed seam:

1. Focused attachment test: Owner suspends, child raw output reaches physical output, input/resize route to child, and close restores Owner.
2. Retarget test: only the new child reaches physical output and receives subsequent physical input/resize.
3. Failure test: child setup failure/exit restores Owner exactly once.
4. Control protocol test: child presentation reinitialization stops/starts its exact TUI and responds only after redraw is requested.
5. Real PTY acceptance: Owner → child → child → Owner preserves drafts, native mouse scrolling, dialogs, and resize.
6. Herdr gate: child Answer reaches Owner, Owner settles authoritative idle, and no child process or Runtime artifact leaks.

Final validation:

```text
npm run typecheck
npm test
npm run test:conformance
npm pack --dry-run
npm audit --omit=dev
git diff --check
```

## Progress

- [x] Throwaway two-process PoC proved raw PTY hot-swap, independent drafts, repeated retargeting, and native mouse scrolling after terminal-mode replay.
- [x] Architecture confirmed: one attachment coordinator, direct Owner presentation Adapter, reusable child PTY Adapter.
- [x] Direct-attachment endpoint with raw output and exclusive terminal-reply ownership.
- [x] Child presentation reinitialization over closed Control.
- [x] Physical terminal attachment with atomic output/input handoff, PTY output backpressure, Owner suspension, child retargeting, and exact Owner restoration.
- [x] Live path cut over from component rendering to direct raw child PTY output; detached frame rendering remains diagnostic-only.
- [x] Real PTY acceptance complete for mouse scrolling, input, child-to-child retargeting, Owner restoration, and child input/render failure.
- [x] Real Herdr acceptance: one Owner spawned one process child, received one correlated Answer, and reached Herdr `done`; the child process and transient Control artifacts were gone afterward.

## Surprises & Discoveries

- A terminal screen redraw does not restore DEC terminal modes. The first PoC routed wheel input into the editor because mouse reporting had been disabled during handoff. Production attachment therefore asks the child TUI to reinitialize itself rather than hardcoding mode sequences.
- Literal kernel PTY rebinding is unnecessary. Switching raw byte routing provides the desired behavior while preserving process isolation.
- Pi's public TUI `stop({ preserveScreen: true })` and `start()` methods are sufficient for Owner presentation handoff; no private terminal suspension patch is needed.
- Headless xterm must stop generating terminal replies while the physical terminal is attached, otherwise the child can receive duplicate query responses.
- Non-TTY SDK and test hosts are not physical attachments. They keep xterm as the terminal responder and use the detached diagnostic surface without restarting child presentation.

## Decisions

- Process isolation remains authoritative because it contains cross-Agent extension and compaction/context state.
- Owner stays directly attached to the Herdr-managed physical PTY; only child processes use `node-pty`.
- Child native TUI output is the live renderer while selected.
- Headless xterm remains detached state machinery, not an active presentation renderer.
