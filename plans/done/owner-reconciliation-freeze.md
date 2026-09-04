# Owner reconciliation responsiveness

## Goal and evidence

Keep Owner input and native spinner updates responsive while an established workflow has outstanding Requests and receives bursts of host state changes. A live profile placed 92% of a five-second sample beneath operational-incident reconciliation, chiefly request relationship lookup. An isolated 86-Agent transcript fixture stalled a timer for 2.3 seconds while resolving 17 Creation Requests, rereading 617 MB across 1,479 inspections.

## Scope and constraints

Fix request-evidence acquisition and redundant operational reconciliation directly. Preserve transcript authority, visibility of new appends, Request identity and target rules, lifecycle ordering, Moderator behavior, safe-boundary waits, and shutdown. Avoid long-lived transcript caches, polling delays, dependency changes, and unrelated presentation changes. Work begins at 00851c9 in an isolated worktree. The existing activity-redraw change is retained.

## Plan

1. Add a failing regression at the Request resolution boundary using real committed Creation Request evidence and bounded transcript acquisition. Implement the smallest general correction, then rerun the captured-workflow lookup probe.
2. Add a failing responsiveness regression for bursts of real host state changes at the operational-incident integration boundary. Coalesce redundant pending reconciliations and yield to native input/timers without losing state changes, errors, or safe-boundary semantics.
3. Measure the combined change on the captured transcript fixture and a representative active reconciliation workload. Expand evidence acquisition only where the measurement shows remaining repeated work.
4. Run focused protocol, operational-incident, transcript, and presentation validation, plus typecheck. Obtain independent Standards and Spec reviews against 00851c9; address in-scope findings. Commit and prepare the separate PR, preserving the user's existing rebase-merge preference.

## Validation boundaries

- RequestEvidence / MessageCoordinator request resolution: committed source and target remain correct, unrelated transcript histories are not read for identity-backed Creation Requests, and a later call sees fresh durable evidence.
- OperationalIncidentCoordinator host event integration: a burst does not monopolize the event loop; state changes arriving during reconciliation receive another pass; reachSafeBoundary and shutdown remain correct.
- Existing real workflow tests cover Deadlock, Obligation Stall, Run Failure, Moderator resolution, and cancellation.
- Repeat the captured 17-request lookup with the same message IDs and compare wall time, heartbeat delay, bytes, and file reads. The diagnostic 100 ms responsiveness threshold is a measurement target, not a new runtime setting.

## Progress

- Worktree created; live profile and original reproduction retained outside the repository.
- Creation Request regression failed on unrelated transcript acquisition, then passed after resolving the Identity-backed request first. Ordinary Request lookup also reuses its author inspection for source and target resolution.
- The same captured 17-request lookup now takes 12.8 ms with 17 reads / 3.24 MB, compared with 2,302.8 ms / 1,479 reads / 617 MB. Resolved identities match.
- The host-change regression failed because evidence scans ran before a queued native event. Pending passes now coalesce within the existing lane and yield with setImmediate before observation starts. Tests also cover fresh evidence in a successor pass, reported failure followed by successful reconciliation, and shutdown fencing.
- Combined production incident-coordinator probe: 86 captured Agent records, 10 Owner-authored Creation Requests retained by a real Owner Runtime Host, six host changes. Baseline took 7,344.6 ms and delayed a queued native event 7,345.1 ms while reading 2.34 GB (5,220 reads). The fix completed in 85.3 ms with a 0.2 ms event delay and 28.4 MB (10 reads), with no errors. The replay models this active Request graph; it does not reconstruct the entire live process's transient state.
- Validation complete: 60 focused tests (including the five new regressions), 26 incident scenarios, seven Request lifecycle cases, three selector/Message lifecycle cases, and two native fullscreen PTY cases pass: 98 passing tests total. Typecheck and diff checks pass. The remaining incident test fails on its exact tool-list assertion because the installed Pi host includes powershell; that same test was run separately on unchanged 00851c9 and fails identically. The full integration suite was not run.
- Independent Standards and Spec reviewers inspected 00851c9...3d97644 and reported no actionable findings. The original dedicated reviewer role was unavailable on this account; both completed reviews used the available default agent runtime.

## Decisions

The direct Creation Request lookup and bounded scheduling remove the measured stall without a transcript cache or new shared snapshot abstraction. Every observation continues to read fresh authoritative evidence. No dependency or runtime policy setting changes are needed.

## Outcome and limits

The reproduced request-scan and host-event-burst stalls no longer occur in the isolated measurements. The live user's Pi process was not restarted or modified during implementation. Loading the fix requires updating that installed extension after merge and restarting or reloading Pi. The measured replay does not guarantee a latency ceiling for every possible history or reconstruct all active Run Failure/Moderator state; unrelated runtime failures and dependency discrepancies remain outside this change.
