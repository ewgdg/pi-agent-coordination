# Restore the `/agents` selector overlay

## Goal

Replace the Owner-only flat `ui.select` placeholder with the accepted, presentation-owned `/agents` overlay required by issue #50, while preserving native session selection, Human Request focus, and passive Operational Attention behavior.

## Intention

Build the smallest production surface around Pi's native `SelectList` and `ui.custom` overlay seam. Keep the command handler limited to obtaining a roster, opening the surface, and dispatching the selected action. Keep hierarchy, recency, runtime state, and selection authority in the coordinator.

## Scope & Constraints

- Implement explicit Live and Dormant tabs in a fully framed centered overlay capped at 80 columns, terminal height, and ten visible roster rows.
- Live uses one continuous `SelectList` across Attention Inbox, Owner, and scoped Agent sections. It shows direct children in creation order and supports arrow/Vim navigation and bounded breadcrumbs.
- Dormant is a passive flat recency view of every verified dormant ordinary Agent and Moderator.
- Focus details use a stable four-row budget for description, identity, Run/Retention semantics, and model/thinking/queued-input state.
- Live and Dormant Enter delegate identity-based native selection; Dormant selection never starts a Run. DECIDE opens its exact Human Request, while exhausted ATTENTION remains passive.
- Preserve current transcript authority and do not introduce durable presentation state or compatibility paths.
- Follow vertical-slice TDD at the `/agents` command, overlay component, native selection, and PTY seams.

## Work Plan

1. Add a failing command/overlay tracer test proving `/agents` creates a custom framed Live/Dormant surface and no generic select view.
2. Add the presentation-owned overlay and the minimal coordinator roster projection needed for focused runtime details.
3. Port bounded scrolling, stable details, attention focus, direct-child zoom, parent navigation, breadcrumbs, and keyboard tab behavior one observable test at a time.
4. Port dormant recency, Moderator marker/trigger, and passive-focus coverage.
5. Rebind current flat-select integration tests to the overlay's public input seam and prove Live selection, DECIDE focus, and passive Dormant behavior.
6. Add the PTY framed-overlay assertion and update user-facing `/agents` documentation.
7. Run Standards and Spec reviews against the starting commit, fix all material findings, then run focused, conformance, type, and full package gates.

## Validation

- Focused overlay and `/agents` behavior tests after each red/green slice.
- `npm run typecheck`
- `npm run test:conformance`
- `npm test`
- PTY test included in the full/conformance gates.

## Progress

- [x] Issue #50, accepted prototype, cold-host decision, current placeholder, and host UI seams inspected.
- [x] Public test seams pinned from the issue's regression contract.
- [x] First custom-overlay tracer failed against the generic selector path.
- [x] Overlay behavior is green.
- [x] Existing integration coverage is migrated.
- [x] Standards and Spec reviews, review fixes, and final package gates pass.

## Surprises & Discoveries

- Production already provides hierarchy/creation order and dormant recency in `selectionRoster`; the missing work is the presentation seam and focused runtime projection.
- Pi exposes native live queue count, model, and thinking state through `AgentSession`; dormant configuration remains available from canonical identity/effective configuration.
- The current issue #50 contract delegates Dormant Enter to the identity-based selection seam while leaving successor startup and dormant transcript binding to #56.
- Pi resolves the overlay's `90%` maximum against total terminal rows before applying margins, so the component budgets against both limits and preserves its bottom frame instead of relying on TUI clipping.

## Decisions

- Tab/Shift-Tab switches Live and Dormant because arrow keys remain reserved for scoped hierarchy navigation.
- Dormant focus is passive, while Dormant Enter delegates the Agent identity without starting a Run. Exhausted ATTENTION Enter remains passive.
- The Live hierarchy contains ordinary Agents only. Dormant includes marked Moderator rows with their trigger descriptions.

## Outcomes & Retrospective

`/agents` now opens one presentation-owned framed overlay with explicit Live and Dormant tabs. Live preserves attention-first native selection, fixed Owner visibility, scoped direct-child navigation, stable details, and exact DECIDE dispatch. Dormant preserves verified Pi-recency ordering, Moderator context, passive focus, and no-start identity selection delegation.

The review pass found five Standards issues and four Spec gaps. Fixes removed obsolete selector vocabulary, made the integration driver depend on stable visible contracts, restored the runtime thinking-level type, shared list-window rendering, respected Pi's real height cap, stabilized scrolled section geometry, and retained the current scope on very narrow terminals. Both reviewers confirmed every finding resolved.

Final validation passed strict typechecking, the 51-test host conformance gate including the real PTY, the complete test suite, production dependency audit with zero vulnerabilities, `git diff --check`, and a 72-entry package dry run containing the new surface and documentation.
