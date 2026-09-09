# Request steering controls attention, not execution order

## Goal and intention

Implement issue #117: bring urgent Requests to an Agent's attention without forcing its choice of work or Answer order. Preserve final standalone Answer behavior so the model does not generate a redundant summary.

## Scope and constraints

- Reuse creation-time `deliveryMode: "steer"`; no numeric priority or mutation/escalation operation.
- Steer Requests bypass foreground ancestry restrictions at safe model boundaries, including parked Wait preemption, without aborting tools or bypassing Holds.
- Answer may resolve any delivered unresolved incoming Request and only that obligation.
- `agent_wait` without selection captures all caller-authored outstanding outbound Requests; optional non-empty `requestMessageIds` captures only the selected caller-authored outstanding Requests. Validate before scheduling; keep fixed snapshots and existing retrieval/preemption invariants.
- Remove Answered/Resumed transition presentation and runtime-designated next work. Use the standard messaging `sent` receipt for Answer, with no repeated Answered/Request-ID text. Keep standalone Answer, `terminate: true`, and no-summary guidance.
- Preserve immutable Request identities, original causal evidence, cancellation isolation, and exactly-once delivery/retrieval.
- No compatibility layer for removed semantics. No unrelated cleanup or full integration suite.

## Work plan

1. Resolve ownership/Wait scope and post-Answer continuation against existing evidence and Pi runtime behavior.
2. Add focused behavioral regressions through existing Request protocol, coordination tool, and native-host test interfaces; implement each behavior incrementally.
3. Update maintained docs/glossary/tool guidance to the attention model; remove obsolete foreground-only Answer and resumed-transition contracts.
4. Review implementation against attention freedom, continuation progress, cancellation and ownership invariants. Run targeted tests and typecheck; commit task-owned changes.

## Validation

Use existing public test interfaces: authored tool calls and canonical transcript projection for Request/Answer contracts, and native-host model/tool loops for safe-boundary delivery and terminal Answer. Cover unrelated Steer during active work and Wait, either Answer order, invalid Answer targets, pending Steer ordering, no resumed transition/summary, retained outstanding work, and cancellation/Wait ownership. Run only relevant fast/process test files or name-filtered cases; no full suite.

## Progress

- Planning issue and user discussion reviewed; implementation authorized.
- Confirmed Request schema already exposes Steer, while Request eligibility still gates delivery by foreground ancestry/cooperative waiting and scheduler currently selects only the first eligible Request before filtering by delivery mode.
- Design inspection completed for ownership, cancellation, and terminal Answer continuation. Foreground-based dependency inference is incompatible with free execution order; use Agent-owned outbound relationships and keep immutable attention ancestry only as scheduling provenance.
- Focused baseline passed: causal-obligation-stack, request-resolution, message-tool (21 tests).
- User extended the ticket with optional explicit Wait selection after agreeing that no-argument Wait should cover all outstanding outbound Requests. No implementation beyond this plan yet.

## Decisions

- Attention is presentation ordering, not execution authority. Delivered unresolved Requests remain actionable regardless of their attention position.
- Outbound relationships belong to the author Agent. Explicit Wait selection narrows the join only, not general obligation/dependency tracking. No dependency transfer when an incoming obligation is answered or cancelled.
- `terminate: true` is set by the Answer tool implementation. It ends the current model/tool loop; it is not Agent termination or a guarantee of immediate Pi `agent_settled`.

## Surprises and discoveries

To be updated at implementation checkpoints.

## Outcomes and retrospective

Pending.
