# Selected-child quit enters Workflow shutdown

## Goal and scope
Treat announced native quit of the selected process child as orderly Workflow shutdown before Control/process loss can trigger Run Failure or Delivery Stall moderation. Preserve unexpected exits, unselected child loss, reload, and host disposal. No deployment or unrelated fixes.

## Work plan
1. Add persistent regressions through actual child lifecycle and public Workflow coordinator, plus low-level exit controls; capture RED.
2. Connect the authenticated quit event to a synchronous Workflow admission/Wait fence for the selected exact projection. Only accepted orderly quit fences expected transport loss. Keep native Owner disposal in its existing lifecycle.
3. Run focused tests, document semantics, commit.

## Validation
Focused hosted-runtime and operational-incident regressions; selected-child CLI quit and reload where feasible; TypeScript check. No full suite.

## Progress
- Clean baseline verified: a94b59c.
- Read investigation evidence and native shutdown lifecycle docs. Existing session.shutdown event precedes process exit, but is ignored by hosted supervision. Presentation forwards exit only after process-exit failure handling.

## Decisions and discoveries
- Reuse the existing authenticated `session.shutdown` event and the existing post-exit terminal restoration/native Owner shutdown path. No new Control protocol or Pi API is needed.
- The Workflow accepts quit only for its currently selected exact projection. Acceptance synchronously fences admission and releases Agent Wait; hosted supervision then makes that Runtime unavailable and rejects pending delivery without emitting Run Failure.
- Preserve unselected native quit as Run Failure: otherwise unresolved obligations would silently lose their responder while the Workflow remained open.
- Ignore late lifecycle events once unavailable: a regression demonstrated that an announced quit could otherwise be revived by a late agent.start.
- CLI tests initially could not bootstrap because this delegated agent's PI_AGENT_COORDINATION_* launch environment leaked into the test Owner. Clearing those four launch variables in the command (not changing source) makes both selected quit and reload pass.

## Outcomes and validation
- RED: `node --test --test-name-pattern="selected-child native quit" tests/operational-incidents.test.ts` failed: Workflow shutdown signal was false when presentation observed exit.
- Additional RED: `node --test --test-name-pattern="hosted child shutdown classification: selected_quit" tests/pi-child-hosted-runtime.test.ts` failed when a late lifecycle event changed unavailable back to active.
- GREEN: `node --test tests/pi-child-hosted-runtime.test.ts`: 12 passed, including real Control loss/process kill and selected/unselected quit, reload, unannounced successful exit, signal exit, host disposal, and pending-delivery cancellation.
- GREEN: `node --test --test-name-pattern="selected-child native quit|unselected child.*native quit|shutdown before Moderator bootstrap|orderly shutdown closes exhausted|one failed provider request creates Run Failure" tests/operational-incidents.test.ts`: 5 passed. Public coordinator/native child PTY regression verifies early shutdown fence, pending Agent Wait rejection, no Moderator identity, and eventual Dormant Owner/child.
- GREEN: `env -u PI_AGENT_COORDINATION_BOOTSTRAP -u PI_AGENT_COORDINATION_SYSTEM_PROMPT_PATH -u PI_AGENT_COORDINATION_SYSTEM_PROMPT_MODE -u PI_AGENT_COORDINATION_LOAD_CONTEXT_FILES node --import ./tests/support/pi-test-environment.ts --test --test-name-pattern="native quit in the selected child|interactive /reload keeps" tests/coordinated-workflow-pty.test.ts`: 2 passed. Actual selected-child /quit exits the CLI; /reload retains the same process.
- `npm run typecheck` and `git diff --check` pass.

## Limitations
No full integration suite or installed plugin deployment. The historical human Ctrl+C incident is not proven: the selected process at the time remains unknown. Persistent tests use native /quit (the same Pi quit lifecycle), not reconstruction of the user's exact key timing. Normal native Owner disposal still follows terminal restoration and child process exit; the new semantic admission/Wait fence precedes both.

Evidence logs are retained in the agent artifact store under project pi-agent-coordination, date 2026-09-07, task selected-child-quit-fix.
