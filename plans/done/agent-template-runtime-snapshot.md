# Agent Template runtime snapshot

## Goal

Stop discovering Agent Templates at every Agent Run. Capture one model-visible Agent Template catalogue snapshot when an Agent Runtime is prepared, and expose that snapshot through the active `agent_spawn` tool's prompt guidelines rather than a catalogue-specific `before_agent_start` system-prompt mutation.

## Intention

Filesystem discovery belongs to Runtime preparation. Prompt construction should consume already-resolved runtime state without I/O. The catalogue guides template selection, while actual `agent_spawn` Runtime preparation continues re-resolving the selected Template from current files.

## Scope & Constraints

- Preserve pre-`session_start` Owner tool registration so historical tool calls retain native renderers.
- Keep Owner coordination tools inactive until admission completes.
- Capture the Owner snapshot during initial admission and refresh it on Pi resource reload.
- Capture an ordinary child snapshot during each fresh Runtime preparation; retained Runtime Runs reuse it.
- Put the rendered Template catalogue only in `agent_spawn.promptGuidelines` while that tool is active.
- Remove the catalogue-specific `before_agent_start` hook.
- Do not make the live catalogue a dynamic tool-schema enum.
- Spawn-time Template selection remains authoritative and re-reads disk.
- Follow the confirmed public test seams: model prompt, snapshot lifecycle, and spawn authority.

## Work Plan

1. Add a failing prompt-surface test proving `agent_spawn.promptGuidelines` owns the catalogue and no catalogue hook is needed; minimally move rendering into tool registration.
2. Add failing runtime-snapshot behavior tests proving template edits do not affect a retained Runtime but reload/new Runtime preparation refreshes the snapshot; minimally capture/store snapshots at Runtime preparation seams.
3. Preserve and verify spawn-time current-file re-resolution.
4. Update glossary/docs to state catalogue snapshot lifecycle and prompt ownership.
5. Run focused tests, typecheck, relevant process tests, diff checks, and a focused review.

## Validation

- Targeted `participant-tool-registrar`, `owner-bootstrap`, `agent-templates`, `process-child-session-factory`, and child bridge/process tests.
- `npm run typecheck`.
- Avoid the full integration suite unless focused blast-radius validation is insufficient.
- `git diff --check` and clean debug/artifact check.

## Progress

- [x] Confirmed public test seams with the user.
- [x] Prompt-guideline vertical slice red → green.
- [x] Runtime snapshot lifecycle vertical slices red → green.
- [x] Spawn authority regression verified.
- [x] Documentation and validation complete.

## Surprises & Discoveries

- Pi same-name `registerTool()` replaces the extension-owned definition and immediately refreshes tool prompt metadata. This preserves pre-session renderers while allowing the prepared Snapshot guideline to replace the generic definition after admission.
- Process child tests may intentionally launch without Owner participant handlers. Such standalone Runtimes keep generic coordination definitions and skip the unavailable Snapshot request.

## Decisions

- The snapshot is model guidance, not durable protocol evidence or execution authority.
- Explicit resource reload is the refresh seam for a retained Owner Runtime; ordinary prompts do not inspect template files.
- The owner-child Control method is named `coordination.templateSnapshot`; no obsolete dynamic-catalogue method is retained.

## Outcomes & Retrospective

Agent Template discovery now runs at Owner admission/reload and fresh ordinary Runtime preparation rather than at every Agent Run. Prepared snapshots travel through the existing Owner-child Control seam and re-register the active `agent_spawn` definition with snapshot-backed prompt guidance. The catalogue-specific system-prompt hook and dynamic catalogue terminology were removed. Spawn-time Template resolution remains current-file authoritative.

Validation passed: focused red/green tests, 37 combined activation/bootstrap/tool/protocol tests, the relevant real process-child prompt test, the successor Template re-resolution regression, `npm run test:fast`, TypeScript checking, and whitespace validation. Independent review found no blocking defects; its documentation wording finding was corrected.
