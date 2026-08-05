# Fork the Workflow Owner into a fresh Workflow

## Goal

Implement GitHub issue #45 so Pi's native fork and clone operations create a fresh independent Workflow only when invoked from the currently admitted Workflow Owner.

## Intention

Use Pi's cancellable `session_before_fork` boundary as the sole live admission gate. A permitted native replacement keeps Pi's copied conversation as model context, shuts down the source Workflow's transient host cleanly, and lets ordinary Owner bootstrap append one matching Identity for the new Pi session. That matching Identity remains the current-protocol cutoff, so copied earlier coordination evidence grants no authority in the new Workflow. The new Owner-derived transcript directory provides an empty independent discovery scope without copying, filtering, or rewriting source Agent transcripts.

## Scope & Constraints

- Implement issue #45 only; do not add Moderator runtime creation or later incident behavior.
- Permit fork and clone only from an initialized current Workflow Owner. Cancel ordinary-child and Moderator attempts through Pi's live hook.
- Preserve copied native conversation/history context. Do not remove or rewrite earlier coordination evidence.
- Append exactly one new matching Owner Identity through normal session-start bootstrap; do not add a fork marker or a second state authority.
- End only transient source-Workflow hosting during Pi's replacement. Preserve the source transcripts so reopening the source Owner reconstructs its Workflow normally.
- Keep the fresh Workflow's ordinary-Agent discovery anchored to its new Owner identity and initially empty.
- TDD seams are fixed by issue #45 and parent issue #34: Pi's real native runtime fork/clone call, role-bound extensions, resulting transcript evidence, and public coordination tools. Do not test private helpers.
- Preserve the clean current branch and the four existing commits ahead of `origin/main`.

## Work Plan

1. Extend the real Pi host harness to support native session replacement and extension rebinding without replacing its deterministic model or public test seam.
2. Add a failing integration slice proving child and Moderator fork/clone cancellation through `session_before_fork`.
3. Implement role-bound fork admission for the public Owner bootstrap and hidden ordinary-child extension.
4. Add a failing Owner clone slice after nested spawn and an unresolved delivered Request. Prove fresh Owner identity/cutoff, copied model context, empty authority, old-identity failures, independent child creation, and source-Workflow continuation.
5. Implement fork-replacement cleanup that fences and disposes transient source Workflow Runs while restoring Pi's native runtime disposal before the new Workflow binds.
6. Add the native fork-position slice with transcript branches and external preparation coverage, retaining copied context while admitting only a normal matching bootstrap for any non-Owner role.
7. Document the Owner Fork contract directly in `docs/owner-workflow.md`.
8. Run focused tests and typechecking throughout, then the full suite, build, package dry run, production audit, and diff checks once.
9. Run independent Standards and Spec reviews against the pre-implementation commit, repair findings, revalidate, move this plan to `plans/done/`, and commit semantically with `Closes #45` as the first body line.

## Validation

- Focused Owner-fork integration tests through `AgentSessionRuntime.fork` for both fork and clone positions.
- Focused Owner bootstrap, cold recovery, spawn, Agent Request, Run supervision, and host-shape suites.
- `npm run typecheck` throughout implementation.
- Final `npm test`, `npm run typecheck`, `npm run build`, `npm pack --dry-run`, `npm audit --omit=dev`, and `git diff --check`.
- Two-axis review against the pre-implementation `HEAD`. Standards sources: `AGENTS.md`, `CONTEXT.md`, relevant completed plans/docs, and the smell baseline. Spec sources: issue #45 and the Owner-fork decisions in parent issue #34.

## Progress

- [x] Inspect issue #45, parent Owner-fork decisions, current identity cutoff/discovery behavior, Pi 0.83.0 fork/clone lifecycle, and public integration seams.
- [x] Fix the public TDD seams and initial design.
- [x] Prove and implement role-gated native fork/clone.
- [x] Prove and implement source teardown plus fresh Workflow bootstrap/isolation.
- [x] Document the public contract and pass focused integration validation.
- [x] Independently review, revalidate, and commit.

## Surprises & Discoveries

- Pi implements `/clone` by calling the same runtime fork operation at the current leaf with `position: "at"`; both operations emit `session_before_fork`.
- Pi creates a fresh native session header before the replacement session emits `session_start`. The copied entries retain their original identities, so normal Owner bootstrap can append the only Identity matching the new Pi session.
- Existing `currentCoordinationScope` already starts immediately after the Identity matching the queried Agent ID. A fresh Owner identity therefore excludes all copied source-Workflow evidence without transcript mutation.
- Pi's native fork teardown disposes the current `AgentSession` directly rather than invoking the runtime's intercepted `dispose`. Source Workflow cleanup must therefore run from the replacement lifecycle and restore native runtime disposal before the fresh Workflow installs its own exactly-once wrapper.
- Pi's static `SessionManager.forkFrom` path copies a transcript without emitting `session_before_fork` and later starts with an ordinary startup reason. Fresh Owner adoption must therefore reject unmatched copied participant bootstraps unless Pi reports the admitted live fork replacement reason.

## Decisions

- Keep fork authorization role-bound in extension closures. The public bootstrap extension permits fork only after successful current-Owner admission; hidden child extensions always cancel.
- Reuse ordinary Owner bootstrap and current-scope lookup instead of adding fork-specific transcript schema.
- Reuse the Owner-derived Workflow directory. The new Pi session identity naturally selects a different discovery namespace.
- Treat source continuation as transcript continuity after clean transient-host shutdown, not simultaneous continuation of the replaced source Owner Run.

## Outcomes

- Native Owner fork and clone now create a fresh isolated Workflow while retaining Pi's copied conversation as model context.
- Ordinary children and Moderators cannot fork or clone, and offline copied participant transcripts cannot be adopted as a new Owner.
- Fork replacement shuts down transient source Workflow hosting without deleting its transcripts, so the source Workflow remains reopenable.
- Independent Standards and Spec reviews found no violations or missing requirements.
- Final validation passed 124 tests, typecheck, build, package dry run, production audit with zero vulnerabilities, and diff hygiene.
