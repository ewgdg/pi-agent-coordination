# Short Workflow-scoped canonical IDs (#101)

## Goal and boundaries
Allocate canonical Agent (`a1`, ...) and Message (`m1`, ...) IDs using separate durable atomic counters per Workflow. Requests use Message IDs. Preserve source attribution, retries, transcript replay and compaction; never recycle allocations. Do not change Request scheduling (#102), add aliases, or retain the replaced identity protocol. Work in `.worktrees/short-canonical-ids`, based on cb47e58.

## Design and evidence
The Owner coordinator executes child requests through authenticated participant control; child processes do not instantiate a WorkflowCoordinator. Multiple Owner processes can nevertheless reopen one Workflow. Use SQLite transactions for source assignments and decimal text counters (BigInt arithmetic, no fixed width). Store the allocation ledger in Pi's user directory; it is durable identity state, not reconstructible projection state. Workflow identity remains the globally unique Owner Pi session ID. Agent Identity explicitly binds its local ID to its Pi session ID. Durable tool pointers include Workflow scope.

## Work plan
1. Establish failing tests at the existing Owner/tool seam and the allocator's public persistence contract.
2. Implement allocation, explicit session bindings and scoped source attribution.
3. Update routing, projections, cold recovery, tool guidance, docs and fixtures.
4. Independent Standards/Spec review, address findings, focused validation, typecheck, packaging and diff checks. Avoid the full integration suite per repository guidance.

## Validation
Owner bootstrap and fork, registered spawn/message/retry/retrieval tools, cold transcript reopen and compaction, cross-process allocator concurrency and retry, independent Workflows reusing local IDs, cancellation/deletion preserving counter history. Use isolated temporary Pi user directories for probes.

## Progress
- Read issue, repository guidance, identity implementations and coordinator/process boundaries.
- Created isolated worktree; main remains untouched.
- Checked Node SQLite documentation: DatabaseSync and timeout are available in supported Node 22.19+.

- Completed the allocator, scoped evidence, explicit Pi session bindings, cold recovery filtering, and full canonical-ID presentation. Updated control protocol to version 8 for the changed wire contract.
- Added public regressions for independent Workflows, concurrent allocation from four processes, retry, restart, cancellation, compaction, deleted transcripts, and foreign evidence with colliding local IDs.
- Independent Standards and Spec reviews completed with no unresolved findings. Fixed the shared pointer validation, foreign-Workflow recovery grouping, and foreign Delivery/Answer evidence checks identified during review.

## Validation results
- Final focused contract run: 40 passed (allocator, Owner lifecycle, control channel); focused process run: 11 passed (Message retry, Request cancellation, Spawn confirmation loss, cold recovery, native Owner fork); focused Moderator successor lifecycle: 1 passed.
- Fast suite: 371 passed, 9 failed. All nine failures reproduced on unchanged main: control-schema fixture lacks compacting, operational-reconciliation fixtures lack reconstructed Spawn input, parked-delivery fixture lacks addEndedHandler, and participant-lifecycle fixtures lack refreshTranscriptFacts. These unrelated failures were left outside this change.
- Additional baseline limitations: the existing Spawn tool-list assertion expects no powershell tool; the nested native clone scenario times out on main as well. The native branch-fork scenario passes.
- Typecheck, package dry-run, production dependency audit (zero vulnerabilities), and diff whitespace checks passed. Full integration suite intentionally omitted per repository instructions.

## Outcome
Issue #101 is implemented in the isolated worktree. The ledger is durable allocation state, while transcripts remain authoritative for protocol facts. No scheduling policy changes or compatibility layer were added. The user requested a pull request after implementation; the changes are being committed and published for review. Validation evidence is retained under the agent artifacts output directory for pi-agent-coordination, dated 2026-09-07, task short-canonical-ids.
