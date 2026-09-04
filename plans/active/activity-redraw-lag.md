# Keep activity redraws independent of transcript history

## Goal

Keep native Owner and Agent activity rendering responsive as child transcripts grow, while showing current lifecycle, model, thinking, queue, and attention changes.

## Evidence and intention

The observed long-running workflow had 58 child histories totaling 30.6 MB. Replaying a consistent snapshot before an independent duplicate-delivery failure measured 125–133 ms per Owner input redraw. The activity widget inspected six direct child histories twice per redraw, reading 27.7 MB. Removing just that widget eliminated the reads and reduced input latency to 28 ms; native Pi alone measured 5 ms.

Rendering should consume the last published activity snapshot. Activity changes refresh that snapshot through the existing notification contract. Explicit status/roster observations retain current transcript evidence and share one coherent inspection within each status construction.

## Scope and constraints

Work in the dedicated `codex/fix-activity-redraw-lag` branch from main at `063be227e685e01daef945bc767f1b391aa14dda`. Address activity repaint work and the duplicate inspection used to build one presentation status. Preserve durable protocol authority, native input, activity ordering, attention, and lifecycle behavior. Do not repair duplicate deliveries, modify original sessions, or broaden into general transcript caching, filesystem watchers, terminal output buffering, or protocol changes.

## Work plan

1. Add a failing regression at the existing public native TUI/component boundary proving repeated editor/resize/animation rendering uses published activity data and remains responsive without requesting transcript-derived data again.
2. Retain activity snapshots between source change notifications; preserve status refresh and spinner lifecycle. Reuse one transcript inspection for each roster status.
3. Verify real Pi lifecycle/model/thinking/queue freshness using the existing integration helpers, and rerun the isolated saved-session PTY replay against this worktree.
4. Complete independent Standards and Spec review against the fixed base and this plan, address findings, run the final focused checks, and create a semantic commit and draft PR.

## Validation

Use the existing Pi TUI/component boundary, native registered tools/session events, and persisted transcript evidence. A deterministic rendering contract should fail before the fix; timing from the saved-session PTY is supporting performance evidence rather than a fragile CI threshold. Run affected activity, roster/selector, and lifecycle tests plus TypeScript checking. Run targeted process/TUI tests sequentially. Do not run the full integration suite.

## Progress

- Created the isolated worktree from verified current main; the duplicate-delivery fix remains in its own PR.
- Confirmed that existing runtime notifications cover Owner queue and thinking changes, with model changes forwarded by the activity extension. A read-only freshness audit found no newly stale displayed fields; the pre-existing process-child native queue notification gap remains outside this change.
- Added a deterministic public Component regression. It failed on the original renderer when repaint queried live evidence, and now passes for resize/invalidation, animation, published queue/work changes, and animation settlement.
- The dock retains its activity snapshot between notifications. Roster construction shares one transcript inspection across status, configuration, and recency instead of rereading the same history.
- Five focused test files passed, 43 tests total, and TypeScript checking passed. The isolated saved-session PTY replay fell from 125–133 ms to 27.7 ms median input latency; all 20 instrumented redraws had zero child-transcript file reads. Native PTY transition tests and independent review are in progress.
