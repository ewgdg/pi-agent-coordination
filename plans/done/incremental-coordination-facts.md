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
- Use public getEntries() with an entry cursor. Its O(total history) shallow
  enumeration is explicitly accepted by the updated issue and user decision.
  Reader endpoint continuity and public session/header/path identify resets.
- Async production boundaries refresh facts; rendering borrows a snapshot. Shared
  synchronous observations end before every yield. Run startup awaits retained
  relationship reconstruction under its existing startup fence.

## Outcomes

Implementation and declared validation complete. Both independent review axes pass.

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
- Independent review found incomplete-tail rewriting, lazy cold projection parsing,
  repeated residual relationship reconstruction and insufficient heartbeat coverage.
  Fixed each with public regression evidence and recurring full-duration measurement.
- Further Spec review caught unresolved Request bindings, rejected later Cancellation
  effects on Wait and conflicting Retrieval evidence. All have passing regressions.
- Concurrent graph readers now recheck commits after draining a shared operation;
  scope replacement discards pending reconstruction. Run startup catch-up preserves
  existing failure/termination behavior and fences relationship installation on shutdown.
- Final synthetic measurements separate public local enumeration (100 calls: 2 ms
  at 2k entries, 24 ms at 20k) from fact work. Unchanged entry parsing/consumption
  and branch/context reconstruction stay zero. A fixed append consumes one entry.
  A 10k-entry backlog takes 20–31 ms, maximum heartbeat gap below 2 ms.
- Dense MessageCoordinator relationship workload: 200/2,000 settled conversations,
  one new Request, then 2,000 additional conversations. Backlogs take 153–154 ms
  with maximum gaps 6.3–7.5 ms. Retained relationship heap is 1.9/15.5 MB.
- Copied workflow replay selects each session’s current matching Identity: all 89
  records are source-complete, with no exclusions. Ten Owner Creation Requests and
  six host changes reconcile in 13.0 ms, maximum event-loop gap 12.9 ms, zero file
  reads/parses/entry consumption/context reconstruction. Public local observations
  enumerate 28,925 references across 89 calls.

## Final review and validation

- Standards: no remaining actionable findings. Spec: no remaining actionable findings.
- A final concurrent-append regression exposed synchronous source acquisition before
  the relationship budget. Each chunk now refreshes sources asynchronously, pins
  the returned views, and reacquires evidence before completing an update.
- Independent Spec probe: 100,000 concurrent entries consumed, at most 256 between
  callbacks, maximum event-loop gap 6.0 ms.
- Final typecheck and diff whitespace check pass.
- Final sequential contract, Message and native Pi host checks: 151 passed.
- Selected Wait, Cancellation, incident and cold-recovery cases: 14 passed.
- Fullscreen native PTY /agents scroll/return-to-Owner case: 1 passed.
- Full integration suite deliberately not run. The separately diagnosed abandoned-
  branch self-Request case times out on both the unchanged base and this branch;
  it remains outside #94.
- Benchmark data, replay script and validation logs are retained with task evidence.
  No dependency manifest or lockfile changes. PR delivery is authorized; do not merge.
