# Restore the selected-Agent footer status

## Goal

Implement issue #55 by restoring one persistent selected-Agent status in Pi's
native extension-status footer. A non-Owner Interactive Selection will identify
the selected durable Agent and expose its current concise Run state; Owner
selection clears the slot.

## Boundaries

- Use Pi's existing `ExtensionUIContext.setStatus()` seam. Do not replace the
  native footer, add an above-editor widget, append transcript entries, or poll.
- Keep the status presentation separate from #53's scoped activity panel.
- Derive the display from the coordinator's durable Agent record and
  `InProcessAgentHost` observation. The status is a projection, not a new
  protocol state.
- Refresh only from native selection changes and existing Run/session state
  hooks, including identity-bound session replacement.
- Treat Dormant and ordinary Run phases as dim. Color only
  `waiting (human)` as warning; reserve error styling for an observable
  failed current Run, never for Dormant.

## Confirmed public seams

The issue's regression contract is the test agreement:

1. A focused formatter/surface seam verifies label, compact identity, phase
   wording, and theme emphasis.
2. The registered `/agents`/native-selection path verifies Owner clearing,
   ordinary Agent and Moderator selection, Dormant selection without Run
   startup, selected leaf presentation, and status refresh across Run states.
3. A native TUI/PTY assertion verifies the text appears in Pi's footer while
   native cwd, token/context, provider/model, thinking, ordering, and layout
   remain intact.

## Work plan

1. Add failing formatter/surface tests for the accepted footer text and color
   rules, including Dormant and the semantic Run states.
2. Implement the selected-Agent status projection and connect it to the
   coordinator's selection, Run state, settlement, failure, and session
   replacement hooks.
3. Add integration/conformance coverage through the real registered surfaces
   and PTY/native footer, including Owner clearing and a leaf Agent.
4. Update the selector and supervision documentation with the restored
   native-footer projection.
5. Run focused tests and typechecking during the vertical slices. Run
   Standards and Spec review against the starting commit, repair all material
   findings, then run the full suite and package gates.
6. Move this plan to `plans/done/` and commit semantically with
   `Closes #55` as the first body line. Do not push.

## Validation

- Focused selected-status, workflow/conformance, and PTY tests.
- `npm run typecheck`
- `npm run test:conformance`
- `npm test`
- `npm pack --dry-run`
- `npm audit --omit=dev`
- `git diff --check`

## Progress

- [x] Inspect issue #55, accepted prototype, current status/UI seams, and
  adjacent selection/activity boundaries.
- [x] Add failing public-seam tests.
- [x] Implement the selected-Agent footer projection.
- [x] Add native footer and lifecycle regressions.
- [x] Update documentation.
- [x] Complete Standards/Spec review and fix findings.
- [x] Complete final validation, archive plan, and commit.

## Review findings being addressed

- Use the current selected session's compact session identity, matching the
  accepted footer evidence, rather than assuming the durable Agent ID is the
  displayed binding identity.
- Add a real Moderator selection regression and prove Owner clearing leaves an
  unrelated extension status untouched.
- Localize status refresh through selection-change and Run-settlement observer
  hooks instead of scattering lifecycle refresh calls.
- Reuse one compact-identity formatter in production and integration tests.
