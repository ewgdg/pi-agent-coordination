# Report read-state controls

## Goal and intention
Let users triage reports directly in `/agents`, and restore read reports to attention with the same `m` shortcut. Report contents stay immutable.

## Scope and decisions
Use explicit `setReportRead(reportId, read)` operations behind a UI toggle, avoiding ambiguous retry toggles. Persist ordered read-state events with a nullable read timestamp; the latest state wins. Apply consistent state-dependent hints in Attention, Reports, and report detail. No implicit acknowledgment on opening. No compatibility paths.

## Work plan
1. Write focused regression tests for persistence, UI state transitions/failure/pending input, and local/remote wiring.
2. Replace read-only acknowledgment operations with explicit read-state setters across the store, coordinator, transport and surfaces.
3. Update user documentation, run focused tests and typecheck, review and commit.

## Validation
Store cold reopen; repeated desired-state writes; read/unread/read cycles; selector focus and retained history; report detail failures; local/child command parity; transport schema/payload.

## Outcomes and validation
- Added reversible read state to the durable store, coordinator, remote control contract, selector and report detail.
- Read-state events use a timestamp for read and null for unread; replay applies the latest event. Repeated writes of the same desired state append nothing.
- Selector `m` keeps the menu open, advances inbox focus after acknowledgment, retains history selection, and restores unread attention. Detail uses the same state-dependent action.
- Added tests before changing behavior; confirmed failures for the missing selector control and reversible operations.
- Focused validation: 101 tests passed across selector, local/remote command wiring, report detail, persistence, transport, protocol schemas and delivery projection. Typecheck and diff whitespace checks passed.
- Full integration suite intentionally not run. Process-runtime fixture updates are interface renames, covered by typecheck; no new Pi API usage.
