# Goal

Make /agents mouse-wheel scrolling move the visible roster window without changing the selected Agent or its focused detail identity.

# Intention

Separate pointer browsing from keyboard/click selection while preserving the selector's existing pinned Owner/path layout, action hit regions, clipping rules, and native SelectList behavior for keyboard navigation.

# Scope & Constraints

- Wheel only over roster rows/spacing/scroll indicator; tabs, Owner/path, details, frame, and help remain non-scrolling chrome.
- Click and arrows/j/k continue changing selection; wheel never does.
- Keep viewport state local to the selector and clamp it on resize/data refresh.
- Do not modify Pi dependencies, runtime shutdown, or unrelated UI controls.

# Work Plan

1. Add a failing rendered pointer regression proving wheel changes visible rows while selected Agent/details stay unchanged and that clicking a newly visible row selects it.
2. Replace wheel's selection mutation with an independent bounded roster offset; render the offset slice while retaining SelectList selection for keyboard/click semantics.
3. Ensure keyboard movement recenters/keeps the selected row visible and resize/clipping/hit-region behavior remains correct.
4. Update selector documentation and run focused tests/typecheck.

# Validation

- RED/GREEN focused agent-selector-pointer-fullscreen.test.ts and agent-selector-surface.test.ts.
- npm run typecheck.
- git diff --check.

# Progress

- [x] Regression test added and red.
- [x] Independent wheel viewport implemented.
- [x] Docs and focused validation complete.
- [x] Semantic commit created.

# Decisions

- Use a bounded local viewport offset rather than changing SelectList dependency code.
- Details remain attached only when the selected row is in the visible roster slice; they are not duplicated or pinned.

# Outcomes & Retrospective

- Wheel now advances a local viewport offset with bounded up/down behavior, while SelectList selection remains unchanged.
- Keyboard navigation keeps selection visible, and pointer hit regions rebuild against the scrolled slice.
- Focused pointer and surface tests pass (47 tests); typecheck and diff checks pass.
