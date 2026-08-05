# Goal

Implement GitHub issue #47: extend the existing Operational Incident path to exact Run Failure and normalized live Dependency Deadlock conditions, bound each continuous condition to two committed Moderator attempts, and expose exhausted handling as transient Workflow Owner Attention.

# Intention

Deepen the existing `WorkflowCoordinator` moderation seam rather than add a second incident store. Make exact Run endings truthful at the in-process host boundary, derive live conditions from current Run and Request evidence, keep handling and attention volatile, and preserve atomic Moderator Input as the only committed attempt boundary.

# Scope & Constraints

- Start Run Failure handling only for an unexpected exact-Run end with at least one still-unresolved Answer Obligation. Retryable provider events are not terminal; deliberate termination, clean release, orderly shutdown, Holds, Human waiting, selection, optional work, and ordinary model duration are not Incidents.
- Clear Run Failure when a successor Run starts or all qualifying obligations end. A successor's later settled state is evaluated independently as an Obligation Stall.
- Detect a Dependency Deadlock only as a normalized closed component of current settled ordinary Runs whose complete retention and unresolved Request relationships are internal to that component, with no admitted input, required attention, selection, Hold, failed Run, or other progress source.
- Deadlock detection is observational. It grants no authority and performs no cancellation, interruption, termination, or descendant action.
- Keep trigger-specific transient Handling Keys. Do not persist or cold-reconstruct conditions, attempts, exhausted attention, Run history, or a global obligation graph.
- Permit at most two committed Moderator Inputs for one continuous condition. A pre-commit creation failure consumes no attempt. A post-commit startup or Run failure consumes one; the single replacement points to the previous attempt's terminal inspection evidence.
- After the second committed attempt fails, stop automatic creation and publish passive Owner Attention containing the original trigger, affected Agents, and at most two diagnostic pointers until the predicate clears.
- Preserve issue #46 behavior and current trust-based Moderator authority. Do not add legacy paths or migration handling.

# Confirmed Test Seams

Issue #47 extends the issue #46 seams already confirmed by the user:

1. Role-bound `WorkflowCoordinator` views backed by real in-process Pi sessions for trigger predicates, condition continuity, attempt replacement, exhausted attention, and non-trigger behavior.
2. Package activation/reopen through the real Pi extension harness for atomic Moderator Input and host-loss removal of transient handling.
3. The parent coordination spec explicitly admits a pure stable contract test for normalized Dependency Deadlock detection; integration coverage still proves that normalized components start ordinary Moderator handling.

Tests will not inspect Handling maps, attempt counters, or private detector state.

# Work Plan

1. Replace ambiguous generic exact-Run disposal with an explicit host end-cause contract covering clean release, unexpected failure, deliberate termination, and orderly shutdown; notify incident handling only after the exact Run has ended.
2. Generalize Moderator trigger/input validation from Obligation Stall to discriminated Stall, Run Failure, and Dependency Deadlock snapshots with sorted bounded Request sources, affected-Agent watermarks, and an optional previous-attempt pointer.
3. Add Run Failure observation keyed by exact Run incarnation and qualifying obligations. Revalidate from transcript-backed Request evidence across dormancy and clear on successor start or obligation completion.
4. Add deterministic closed-component detection over current Request relationships, normalize Agent and Request order, and project qualifying components into trigger-specific Handling Keys without mutating Runs.
5. Generalize continuous-condition reconciliation and Moderator Resolution across all trigger variants while keeping old attempts independently resolvable after recurrence.
6. Track committed attempts per continuous condition. Continue once after a post-commit failure, then publish and later clear passive Owner Attention.
7. Render exhausted attention in the native Owner presentation and expose it through the role-bound view for deterministic verification. Keep it volatile and Owner-scoped.
8. Update current design documentation, complete the required parallel Standards and Spec review against the pinned base, fix findings, run the full validation suite once, inspect the package, and commit semantically with `Closes #47`.

# Validation

- Red-green vertical slices in focused files, primarily `tests/operational-incidents.test.ts`, with pure component tests only at the stable detector contract.
- Run `npm run typecheck` regularly and focused test files after each slice.
- Before the final broad gate, run the mandated parallel Standards and Spec reviews against base `f2af51ff62c663dc6fb9d4a2019a8138b5f83493` and fix confirmed findings.
- Final once: `npm test`, `npm run typecheck`, `npm run build`, `npm pack --dry-run`, `npm audit`, and `git diff --check`; inspect tarball contents for stale compiled modules.

# Progress

- [x] Read issue #47, parent design decisions, issue #46 implementation and retrospective, repository guidance, current Pi host behavior, and the relevant TDD/review instructions.
- [x] Pin the starting branch at `f2af51ff62c663dc6fb9d4a2019a8138b5f83493` with a clean worktree.
- [x] Confirm the inherited public TDD seams and identify the stable deadlock detector contract permitted by the parent spec.
- [x] Complete exact-Run end-cause tracer slice.
- [x] Complete Run Failure moderation slices.
- [x] Complete Dependency Deadlock moderation slices.
- [x] Complete bounded replacement and exhausted Owner Attention slices.
- [x] Complete documentation, both review axes, confirmed review fixes, focused and full validation, package inspection, and the semantic issue-closing commit.

# Surprises & Discoveries

- `AgentRunSettlement === "failed"` currently identifies terminal model error only. Delivery or resumption proof failure can also end an exact Run unexpectedly after settlement, while deliberate termination and orderly shutdown share the same untyped disposal method. Issue #47 therefore requires a truthful exact-Run end-cause seam rather than treating dormancy or model failure as the complete predicate.
- Moderator metadata already defines `run_failure` and `dependency_deadlock`; the missing work is trigger/input validation, live predicates, attempt continuity, and Owner Attention.
- Cold recovery already reconstructs no Handling Key or Incident. The host-loss requirement should preserve that boundary and prove that neither attempts nor exhausted attention are recovered.
- A successor Run can start and end before queued incident reconciliation observes a live handle. Comparing the host's latest started Run sequence to the failed sequence preserves the specified start-clears-Failure boundary across that race.
- A deadlock integration fixture that rejects Creation Request Delivery still leaves the Owner's authored Creation Requests unresolved. Those external edges correctly prevent closure; the fixture must cancel them before forming the component.

# Decisions

- Carry forward issue #46's coordinator and real-Pi integration seams. Add a pure deadlock component seam only because the parent spec explicitly names that algorithm as a stable contract.
- Use explicit end causes at the host disposal boundary. Operational Incident code observes the completed end instead of inferring cause from later dormancy.
- Treat the failed Moderator transcript tail as the previous-attempt inspection pointer. A post-commit startup failure has only its atomic Moderator Input as the available committed watermark; no synthetic lifecycle entry is appended.
- Normalize deadlock components by sorted Agent identities and sorted exact Request identities so one live component has one deterministic Handling Key independent of traversal order.

# Outcomes & Retrospective

Exact-Run end causes now distinguish clean release, unexpected failure, deliberate termination, and orderly shutdown. Run Failure and normalized Dependency Deadlock conditions use the existing transient Operational Incident path, each continuous condition is bounded to two committed Moderator attempts, and exhaustion publishes Owner-only Operational Attention with the original condition and diagnostic evidence.

Independent Standards and Spec review found and fixed unused and duplicated reconciliation code, timing-dependent negative tests, an over-broad presentation interface, dormant Owner baseline lookup, premature clearance during failed successor startup, and incomplete passive condition evidence. The focused post-review gate passed 44 tests plus typecheck and diff validation.

The final gate completed on August 5, 2026:

- `npm test`: 151 tests passed.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm pack --dry-run`: passed with 178 files.
- `git diff --check`: passed.
- Package inspection found both new compiled module triplets, no stale removed module or document, and no source/dist module mismatch.

`npm audit` reports three upstream transitive advisories under `@earendil-works/pi-coding-agent` (one moderate and two high). Resolving those advisories is dependency work outside issue #47; no issue-local package or vulnerability change was added.
