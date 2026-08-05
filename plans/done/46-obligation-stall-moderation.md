# Goal

Implement GitHub issue #46 as the first complete Operational Incident tracer bullet: detect a live Obligation Stall, create one isolated Moderator atomically, let that Moderator diagnose and restore progress under its own role, and resolve handling only after the stalled Answer Obligation is mechanically clear.

# Intention

Keep moderation inside the existing deep `WorkflowCoordinator` seam. Extend the current in-process Agent host, transcript evidence, role-bound tools, and cold discovery directly; do not add an Incident aggregate, durable Handling Key, backend abstraction, or second state authority.

# Scope & Constraints

- Implement only Obligation Stall handling. Run Failure, Dependency Deadlock, Operation Review, replacement attempts, and exhausted Owner Attention remain issue #47/#48 work.
- A Stall requires one live settled ordinary Agent with at least one `answer_owed` relationship and no active or admitted input, qualifying external progress source, or Interruption Hold.
- Derive one transient Handling Key from the affected Agent and its current qualifying Request identities. Suppress duplicate Moderator creation only while that exact continuous predicate remains true.
- Commit exactly one model-visible `agent-coordination.moderator-input` entry as the Moderator identity/configuration/input boundary before starting its Run.
- A Moderator is a standalone known Workflow Agent with no Direct Spawner. It receives `agent_message`, workflow-wide `agent_observe`, workflow-wide non-Owner `agent_control`, `ask_user_question`, and `moderator_control`; it never receives `agent_spawn`.
- Escalation uses an ordinary Agent Request to the Workflow Owner. The Moderator acts only under its own authenticated identity.
- Resolution records summary/rationale in the ordinary tool call, requires all Moderator Request relationships to be settled, revalidates the original Stall, and returns `blocked`, `already_cleared`, or `resolved` without transcript Incident state.
- External obligation clearance immediately releases the Handling Key and Moderator-specific retention, but does not abort active Moderator work or settle its ordinary Requests.
- Cold recovery verifies valid Moderator bootstrap entries as standalone Workflow Agents for routing and inspection. It reconstructs no Stall, Handling Key, Run, scheduling, or Moderator reuse.
- Preserve the user's untracked `.cgcignore`; it is outside this issue and must not be committed.

# Confirmed Test Seams

Confirmed by the user before the first test:

1. Role-bound `WorkflowCoordinator` views backed by real in-process Pi sessions for Stall detection, suppression, Moderator communication/control/escalation, and Resolution races.
2. Package activation/reopen through the real Pi extension harness for atomic bootstrap boundaries, role-scoped tool registration, and Moderator cold discovery.

Tests will not target the detector, Handling Key store, or session factory as private implementation seams.

# Work Plan

1. Define and strictly validate the atomic Moderator Input/Identity transcript contract for the `obligation_stall` trigger, bounded Request sources, sorted affected-Agent watermarks, Owner-derived baseline, and fixed metadata.
2. Add live Stall observation and continuous-condition handling to `WorkflowCoordinator`, using existing Agent lanes, request evidence, delivery scheduling, settlement callbacks, and Run retention without introducing durable Incident state.
3. Create Moderator sessions from the Owner baseline and reserved optional `moderator` template, append the atomic bootstrap before startup, bind the role-specific extension, and integrate the standalone record with messaging, observation, supervision, Human Requests, execution, selection, and shutdown.
4. Add `forModerator` and `moderator_control` interfaces with workflow-wide observation, non-Owner control, own-identity messaging/Requests, blocked/current/cleared Resolution outcomes, and no spawn path.
5. Revalidate and clear handling on every relevant live transition, including Answer commit, Cancellation Delivery, newly admitted work/progress, Hold changes, startup races, and external clearance while Moderator work is active.
6. Extend cold discovery and bootstrap validation so standalone Moderators are verified, indexed, routable, observable, and post-mortem inspectable without joining the ordinary Direct-Spawner tree or reconstructing transient handling.
7. Document the shipped Moderator and Obligation Stall contract under `docs/`, update the package overview, and keep docs focused on the desired current design.
8. Run the mandatory two-axis review against `main`, fix confirmed findings, re-run validation, move this plan to `plans/done/`, and commit with a semantic issue-closing message.

# Validation

- For each vertical slice: observe the focused test fail, implement the minimum behavior, run that test, then run `npm run typecheck` regularly.
- Focused integration coverage: exact Stall predicate and clearing; duplicate suppression; atomic pre/post-bootstrap failure boundaries; ordinary Request escalation; blocked, cleared, and resolved outcomes; external-clearance races; role-scoped tools and authority; cold discovery and malformed bootstrap quarantine.
- Final: `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`.
- Review fixed point: `main` as resolved before implementation (`5930065`). Compare with `git diff main...HEAD` after the implementation commit, and review Standards and issue #46 Spec independently.

# Progress

- [x] Read issue #46, prerequisite issues #41/#42/#44, the canonical Moderator decisions, repository guidance, and the current host/request/supervision architecture.
- [x] Confirmed prerequisite issues are closed and the starting branch is `main` at `5930065`.
- [x] Confirm the public TDD seams with the user.
- [x] Complete vertical TDD slices.
- [x] Complete focused and full validation.
- [x] Complete Standards and Spec review and fix confirmed findings.
- [x] Commit the finished implementation.

# Surprises & Discoveries

- Current code already contains fixed Moderator metadata and execution-scheduler exemption, but no Moderator identity protocol, session construction, coordinator view, role-specific extension, or cold recovery.
- Cold recovery intentionally excludes Moderators today; issue #46 replaces that explicit boundary rather than layering a compatibility path.
- `.cgcignore` appeared untracked during reconnaissance and is not part of this work.

# Decisions

- Use the existing role-bound coordinator and real Pi-session integration seams selected by the architecture spec. Keep pure validation behind those interfaces unless a stable exported protocol contract needs direct coverage.
- Treat the atomic Moderator Input commit as both creation and attempt boundary. Pre-commit failure leaves no Agent; post-commit startup failure leaves a valid dormant/post-mortem Moderator.
- Keep Moderators outside ordinary `children` traversal while including them in workflow-wide Owner/Moderator lookup and live/dormant roster presentation.
- Persist the first Moderator Input through Pi's verified SessionManager seam before Run construction, then continue the AgentSession from that committed input without appending a second model-visible prompt.
- Revalidate all ordinary Agents through one incident lane after observable host transitions so downstream progress and clearance races cannot leave stale handling.
- Associate Resolution with the Moderator owning one active handling, so a later continuous Stall that derives the same Handling Key cannot block or be released by the earlier attempt. Derive its final disposition from durable Request evidence rather than disposable Run retention.

# Outcomes & Retrospective

The implementation now detects continuous Obligation Stalls, follows recursive external progress, creates one atomic standalone Moderator, supplies its fixed role tools and authority, supports ordinary Owner escalation and gated Resolution, releases handling on live clearance, and cold-recovers strict Moderator transcripts without reconstructing handling.

Independent Standards and Spec review found and fixed same-key attempt continuity, terminated-Run obligation evidence, and duplicated Moderator-role classification. Full validation then passed on August 5, 2026 with 136 tests:

- `npm test`
- `npm run typecheck`
- `npm run build`
- `npm pack --dry-run`
- `git diff --check`

The package contains every current source module and no stale compiled module. `npm audit` still reports three upstream advisories in transitive dependencies under `@earendil-works/pi-coding-agent` (one moderate and two high); no issue-46-local vulnerability was introduced or fixed here.

One late integration surprise mattered: full-suite tests that intentionally strand unanswered work can now spawn real background Moderators, which consume the shared faux-model queue. The durable fix was to add an implicit Moderator-response path to the shared test host by default and explicitly disable that path in the focused Moderator tests that need to script Moderator turns directly.
