# Owner selector actions

## Goal and intention
Implement #86's keyboard-only separation of global Owner selection and hierarchy browsing.

## Scope and constraints
Pinned Owner/path in Live and Dormant; linear Attention → Owner → Agent focus; trailing child controls; preserve focused details and bounded terminal rendering. No pointer handling or mounted marker. Exact mounted participant selection closes without replacing its view.

## Work plan
1. Add selector component regression tests at the existing public UI harness seam.
2. Implement focus, pinned rendering, root browsing and breadcrumb width behavior.
3. Add selection-session regression tests and no-reopen behavior (delegated, disjoint remote-selector files).
4. Update docs, run targeted selector/remote-selector tests and typecheck, commit.

## Validation
Use existing selector surface and remote selection public seams requested in the task. Run node --test for those two files, then npm run typecheck; never the full suite.

## Progress
- Read issue body and prototype verdict, current selector and Pi TUI API.
- Remote selection-session work delegated separately; UI and documentation remained local.
- Red/green regressions cover linear Owner focus, root browsing and unavailable-ancestor fallback, pinned scrolling, Attention order, Dormant controls, and Owner preparation feedback.
- A short-terminal Attention regression exposed clipping of pinned Owner by detail rows; bounded detail trimming now reserves that boundary.
- Targeted selector and remote-selector coverage: 42/42 passed.
- Typecheck and git diff --check passed.
- Updated docs/agent-selector.md with controls, focus defaults, breadcrumbs, mounted-selection semantics, and the bounded short-terminal adjustment.

## Decisions
Keep Pi SelectList for keyboard dispatch and row styling, with bounded boundary guards and pinned Owner rendering outside the scrolling row projection.

## Surprises and discoveries
The native SelectList wraps and includes all focus stops in its scroll position. Boundary guards retain native dispatch while preventing wrap. Owner is projected once outside visible roster rows; scroll counts now include the Owner focus stop. Existing focused-detail and horizontal-padding regressions remain green.

## Outcomes and retrospective
Implemented all keyboard-only #86 requirements with no pointer or mounted-marker work. Already-mounted select_agent actions skip presentation acquisition; Human Request decisions still use the normal preparation/focus path. No full suite was run. Parent owns independent review and publishing.

## Review follow-up
- Added a failing regression at widths 20 and 19 for informational omission consuming current-scope space.
- Drop the older-path marker before truncating the current label. Width 20 preserves `[Owner][›] Delta`; width 19 has only 15 content cells after frame/padding, so it preserves `[Owner][›] Del…` instead of the older-path marker.
- Revalidated targeted selector/remote-selector tests (42/42), typecheck, and diff whitespace checks.
