# Goal

Implement GitHub issue #49 by turning the completed coordination tracer bullets into one releasable Pi package with an executable structural and behavioral compatibility gate, a narrow native PTY workflow, complete orderly-shutdown proof, and direct user/maintainer documentation.

# Intention

Keep Pi transcripts, native `AgentSession`s, `InteractiveMode`, and the role-bound `WorkflowCoordinator` as the only product seams. Add focused conformance slices that exercise the concrete installed Pi dependency graph and the existing real-session harness. Change production code only where those tests expose an actual package, host-shape, rebinding, or lifecycle gap; do not create another backend, state authority, compatibility allowlist, or broad permutation suite.

# Scope & Constraints

- The issue-defined public seams are confirmed: the package entry extension, role-bound coordination tools, concrete temporary Pi sessions, the native interactive runtime/TUI, persisted Pi transcripts, and containing-process shutdown.
- Declare every directly imported Pi-provided module as a peer and no Pi module as a runtime dependency or bundle.
- Resolve and validate constructors, session/services, TUI values, and private integration targets from the running host module world. Compatibility is structural plus behavioral; `VERSION` is diagnostics only.
- Keep the primary regression path on the real role-bound coordinator, deterministic no-network Pi model, temporary persistent sessions, concrete host, real transcripts, and controllable clock.
- Test observable transcript ordering, UI/rebinding, tool contracts, and disposal. Do not inspect coordinator maps or replace the host with a fake backend.
- Preserve Pi authority for transcript, editor, history, Vim behavior, native queues/tool frames/footer, and working state.
- Preserve volatile failure limits and the trust-based protocol; do not add persistence or security boundaries.

# Work Plan

1. Pin the clean baseline and map issue #49 plus the accepted Pi integration-shape research to existing implementation/tests/docs.
2. Add a failing package/structural conformance slice for the complete peer set, running-host TUI/module values, every used private seam, version-neutral admission, and no partial bootstrap on incompatibility; make the smallest production/package changes that pass it.
3. Add focused published-host behavioral slices for assistant/tool/result commit ordering, model-visible Delivery, settlement, compaction, all-branch lookup, and restart-safe branch selection without duplicating coordination permutations.
4. Extend the real-session integration harness for retained concurrent sessions, Owner/child native rebinding, continuous selected input, one startup event per session, binding-only refresh, and full long-to-short viewport reconstruction while native state remains authoritative.
5. Add an extension contract slice for ordinary and Moderator role tools, closure-bound caller identity, strict schemas, compact renderers, Workflow Policy reload, Owner bootstrap readiness, and child exclusion of the public bootstrap.
6. Grow the existing PTY seam into one narrow native workflow covering `/agents` Live/Dormant and deselected work, Message/Request round trips, Human Question success/Escape, Holds/resumption, Owner Attention, and native shutdown.
7. Add orderly containing-process shutdown coverage for admission fencing, UI closure, child/Moderator termination, selected/retained-session exactly-once disposal, and startup failure atomicity; repair only confirmed lifecycle defects.
8. Update README and current docs with installation, TUI-only support, Agent Template and Workflow Policy behavior, transcript authority, volatile failure limits, trusted coordination, compatibility gate, and shutdown guarantees.
9. Run focused tests and typechecking throughout. Commit the completed vertical slices, run the required parallel Standards and Spec review against the pinned base, fix confirmed findings, then run the final broad validation once and archive this plan.

# Validation

- Red-green focused Node test files at each public seam; `npm run typecheck` after each material slice.
- Real Pi sessions and deterministic faux provider only; PTY checks use the system `script` utility and no network.
- Two-axis Standards and Spec review against `985e423cff09bcec1adcc0bd318f0feb7cd8a5af`, with issue #49 and the accepted Pi integration-shape decision as Spec sources.
- Final once: `npm test`, `npm run typecheck`, `npm run build`, `npm pack --dry-run`, `npm audit --omit=dev`, and `git diff --check`; inspect packed contents and source/dist module parity.

# Progress

- [x] Read issue #49, repository instructions/domain language, the implement/TDD/review workflows, prior lifecycle plans, and the accepted Pi integration-shape research.
- [x] Pin the clean starting branch at `985e423cff09bcec1adcc0bd318f0feb7cd8a5af`.
- [x] Confirm the issue-defined public TDD seams.
- [x] Complete package and structural conformance.
- [x] Complete transcript and native-interactive behavioral conformance.
- [x] Complete extension and narrow PTY workflow conformance.
- [x] Complete shutdown behavior and documentation.
- [ ] Complete independent review, final validation, plan archival, and semantic commit.

# Surprises & Discoveries

- The existing accepted research already defines issue #49's detailed host contract and exact peer set. It is design evidence only; prototype code will be reduced to current production seams rather than merged wholesale.
- The current suite already proves most coordination semantics in vertical feature tests. The missing value is an explicit host/package gate and one native end-to-end workflow, not another combinatorial protocol suite.
- Pi's extension loader, not ordinary project-local module resolution, is the executable proof that the package receives constructors and values from the running host module world.
- Native `bindExtensions()` emits `session_start`; retained-session reselection therefore needs a binding-only refresh through the current native extension bindings.
- Native differential rendering can retain rows from a longer deselected transcript. One forced full render after Pi reconstructs the replacement session clears the viewport without introducing a second UI authority.
- `InteractiveMode.init()` initializes the real TUI but does not start Pi's containing editor loop. The narrow PTY fixture invokes the registered native command context and drives selector/Human input through the terminal while retaining real package sessions and shutdown.
- A child-spawn test selected the newest Workflow session file, which became ambiguous once a concurrent Moderator could start. Selecting the session whose ID came from the spawn receipt makes the assertion identity-bound and deterministic.
- The first independent Spec review found ungated constructor members, post-shutdown execution admissions, and an incomplete focused conformance command. The first Standards review found one machine-specific path in this plan and duplicated participant lifecycle registration.
- A malformed live runtime was rejected before Owner bootstrap but initially left the process-global capture patch and its pending waiter installed. Live rejection now restores the native prototype, rejects waiters, and removes the failed bridge state.

# Decisions

- Treat the issue's explicit real-Pi coordinator, extension harness, and PTY language as the pre-agreed test seams required by the TDD workflow.
- Keep host conformance focused on Pi semantics that structural reflection cannot establish. Reuse existing feature tests as coverage evidence where they already exercise the same public behavior.
- Use the starting commit as the fixed review point because the user did not supply another comparison and this implementation begins from a clean `main`.
- Keep `npm test` authoritative and expose the structural/native compatibility files as `npm run test:conformance` for focused compatibility checks.
- During shutdown, discard volatile delivery scheduling before disposing each corresponding host, continue every cleanup step after failure, and flatten failures into one Workflow-level `AggregateError`.
- Treat every host member that coordination overwrites as a writable structural seam, not merely a present member.

# Outcomes & Retrospective

To be completed after validation.
