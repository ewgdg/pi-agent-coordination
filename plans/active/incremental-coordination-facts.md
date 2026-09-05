# Reuse trusted coordination facts and consume transcripts incrementally

## Goal and scope

Implement issue #94. Keep Pi transcripts authoritative while retaining disposable
coordination facts and physical consumption cursors. Preserve all-branch evidence,
current identity cutoffs, delivery and incident behavior. Do not address #89 or #75.

## Starting evidence

The isolated worktree starts at 5245599. PR #93 was verified merged on
2026-09-05 at 01:19 UTC; its reconciliation coalescing is already present.
Branch: codex/incremental-coordination-facts.

## Work plan

1. Add public transcript regressions for retained unchanged reads, complete JSONL
   appends, branch changes, replacement and reconstruction equivalence. Implement
   shared consumption with lazy model context and explicit cursor ownership.
2. Index coordination entries and sources in transcript-owned state; migrate
   Request, Answer, Cancellation, Delivery, Wait and incident queries. Trust
   creationInput and Identity after child reconstruction.
3. Remove presentation context reconstruction and bound asynchronous catch-up.
4. Exercise real Owner/Agent histories, including a many-entry backlog. Record
   bytes, parsing, reconstruction, retained memory and event-loop latency.
5. Update maintained docs, conduct independent Standards and Spec reviews against
   starting commit 5245599, fix in-scope findings, run declared focused validation.
6. Commit with Closes #94 as the first body line, push, open PR. Do not merge.

## Validation

Authorized public seams are AgentTranscript over real SessionManager/files and
WorkflowCoordinator/registered tools over real Pi sessions. Start each increment
with regression evidence. Run typecheck and targeted transcript, request-evidence,
message, wait, incident, recovery and selector cases as affected; avoid the full
integration suite. Performance evidence belongs under
~/.agents/artifacts/outputs/pi-agent-coordination/2026-09-04/incremental-coordination-facts/.

## Progress

- Read issue #94, repository instructions and merged PR #93.
- Confirmed existing inspect() eagerly rebuilds branch/context and file history.
- Confirmed Pi getEntries() filters the entire physical array. getEntry() and
  getLeafId() are public, but branch traversal alone cannot find off-branch appends.

## Decisions and open questions

- A physical append cursor is independent of active leaf and inspectedThrough.
- Notifications are hints only; message_end precedes commitment.
- Repository has no docs/agents/issue-tracker.md. The task explicitly supplies
  GitHub issue #94 and gh, so reviews will use that supplied spec directly.
- Determine a bounded catch-up boundary without letting synchronous presentation
  reads publish stale facts or block on a large backlog.

## Outcomes

Pending implementation and validation.

## Implementation checkpoint

- Added shared physical readers, complete-line buffering, cursor-anchor validation,
  lazy branch/context and per-entry settings. Indexed sources/results and retained
  source, Delivery and Retrieval projections are used by coordination consumers.
- Creation Request reads trust loaded child Identity and creationInput.
- Added asynchronous catch-up to tools, lifecycle, incidents and explicit selector
  requests. Rendering borrows retained snapshots. Cold discovery reuses the reader.
- Red/green evidence: unchanged-history reconstruction, partial UTF-8 publication,
  concurrent current readers, and trusted Creation Request tests failed before
  their respective fixes. Existing invalid-call/result regression caught an early
  projection bug; pending invalid calls now remain observable when results arrive.
- Passed transcript/facts/request-evidence, Message, Delivery/target, selected Wait,
  Cancellation, Creation Request and cold-recovery checks, plus typecheck.
- The abandoned-branch self-Request cold-recovery case timed out after 25 seconds
  on both this branch and unchanged 5245599. It is recorded, not modified.
- Synthetic 2k/20k Owner/Agent histories show zero unchanged history work and one
  consumed entry per fixed append. A 10k backlog yielded to a queued event within
  1.5 ms. Retained heap was roughly 3.9 MB for 20k local entries and 19.3 MB for 20k
  file entries, which includes parsed history. Final measurements still pending.
- Captured replay: 82 source-complete records, 10 Owner Requests, six host changes,
  1.4 ms reconciliation, 0.1 ms first queued event, zero incremental history work.
  Four captured child records had missing creation sources and were excluded.
- Independent Standards/Spec review and final declared validation remain pending.
