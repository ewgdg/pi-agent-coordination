# Pointer interaction for /agents (#87)

## Goal and intention
Make the existing participant and hierarchy selector usable with a pointer without changing keyboard navigation or leaking input into the mounted editor.

## Scope and constraints
Use Pi 0.85.1 public Component.handleMouse and normalized mouse events only. The activity dock stays informational. No private geometry, raw mouse decoding, compatibility paths, or unrelated changes. Fullscreen pointer routing is the supported host seam; regular terminal mode remains keyboard-only.

## Design
Keep the centered bounded selector panel, inside a full-terminal modal component. Pi only blocks mouse fallthrough inside overlay bounds, so the component must render all terminal rows/columns even while async view preparation is pending. Render actionable regions together with their text; retain regions through clipping and map only visible cells. Details and truncated breadcrumbs have no action. Primary clicks activate; hover never moves keyboard focus. Scoped wheel uses the established list navigation.

## Work plan
1. Read issue, public Pi docs/API evidence, and existing selector contracts; install worktree dependencies.
2. Add failing selector public-surface tests, then implement modal frame and pointer hit regions in vertical slices.
3. Add real fullscreen renderer tests (delegated: new fullscreen test file only), covering routing, clipping, scrolling, hover and pending view preparation.
4. Document supported behavior, run focused tests/typecheck, review diff, and commit task changes. Do not publish.

## Validation seams
Existing openAgentSelectorSurface custom component seam for actions and keyboard regression tests; real TuiAltScreen terminal-input seam for actual mouse dispatch and mounted editor isolation. These are the requested acceptance seams. No whole integration suite.

## Progress
- Read #87, installed Pi TUI docs and overlay example, API research evidence and local TDD guidance.
- npm ci completed (Pi packages 0.85.1, zero audit vulnerabilities).
- Fullscreen behavior tests delegated independently; production, existing unit tests and documentation remain local.

## Discoveries and decisions
Pi's overlay rectangle is the modal pointer boundary, not keyboard focus. A full-screen outer component is necessary even though the visible panel remains centered.

- Implemented explicit per-line action regions, clipped together with visible content; full-screen modal frame preserves the centered panel.
- Existing keyboard selector contracts pass; public pointer test first failed before implementation.
- Five initial real fullscreen tests failed against the base implementation. Seven fullscreen tests now pass, including wide-character breadcrumbs, partially clipped controls, scrolling, resize, and editor isolation.
- Resize during async preparation initially lost loading feedback; added a failing renderer regression, then retained the spinner across list rebuilds.
- Final focused validation: 66/66 tests pass with 5-second timeout; typecheck and diff whitespace check pass.

## Outcomes and retrospective
The existing SelectList remains authoritative for keyboard and wheel selection. Structured rendered lines carry their own explicit regions through vertical clipping; local display widths define horizontal regions. The only outer layout change is a full-terminal blank shield around the centered panel. No raw mouse parsing, private geometry, compatibility branches, or dock behavior changes were added.

Pointer support is fullscreen-only (Pi regular terminal mode owns its mouse input). Wheel uses SelectList's one-step selection scrolling and excludes tabs, Owner/path, details, help, borders and modal surroundings. Fullscreen validation uses the actual renderer with a headless terminal, not a claimed manual PTY session. Durable verification logs are stored in the agent artifacts output for this task; maintained behavior and reproducible commands are in docs/agent-selector.md and docs/agent-view-acceptance.md.

All implementation changes are committed locally; publication belongs to the parent review workflow.
