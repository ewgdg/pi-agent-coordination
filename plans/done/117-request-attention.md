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
- User extended the ticket with optional explicit Wait selection and suffix matching; implemented Agent-owned dependencies, all/selected snapshots, Steer priority/batching, arbitrary delivered unresolved Answer order, and neutral reminders in `241a31e`, `4d67a22`, and `7648f3a`.
- Implemented ordinary terminal Answer receipts, selected Wait surface/rendering, attention glossary and maintained documentation. Removed the retired Answer transition metadata path rather than retaining compatibility logic.
- Independent surface review found two native lifecycle gaps: queued post-Answer input could cause a duplicate continuation, and `triggerTurn: false` presentation at `agent_start` missed the first generation. Fixed both with native regressions in `934880f`: project the current complete set through Pi's pre-generation context hook and count only the last completed turn for continuation.
- Independent core review found no confirmed correctness bug. Added parked selected-Wait isolation, selected cancellation, and multi-Steer preemption/reservation coverage in `02d375d`; no further production fix was needed.
- Workflow coordination was blocked by a pre-existing moderator-report evidence issue. User repaired the runtime separately; explicit Workflow resume renewed unfinished delegation. Preserved those unrelated repair commits.
- Final combined focused run passed 135 tests across Request/Wait evidence, control schema, reminder/Delivery evidence, tool surfaces/renderers, and lifecycle (including five native generation/continuation tests). Excluded the known unrelated Spawn-description assertion.
- Final process runs passed all seven causal Request/preemption cases, both Deferred-after-Answer cases, and the Steer Wait-preemption case (10 total). Typecheck and diff check passed; no full suite run.
- Supplemental existing Hold/termination tests could not reach their assertions: their shared spawn fixture waited for an obligation reminder and settled live Run. No claim those supervision paths were validated by that attempt; no unrelated fixture changes included.

## Decisions

- Attention is presentation ordering, not execution authority. Delivered unresolved Requests remain actionable regardless of their attention position.
- Outbound relationships belong to the author Agent. Explicit Wait selection narrows the join only, not general obligation/dependency tracking. No dependency transfer when an incoming obligation is answered or cancelled.
- `terminate: true` is set by the Answer tool implementation. It ends the current model/tool loop; it is not Agent termination or a guarantee of immediate Pi `agent_settled`.

## Surprises and discoveries

- An Owner with unresolved self-authored Requests now correctly remains parked under Agent-wide dependency tracking. Answer-order tests wait for Delivery rather than assuming full Owner settlement before answering.
- Public Pi `terminate: true` skips automatic model follow-up but does not discard queued input. Attention presentation must be available before generation, and already-consumed post-Answer input must count as the continuation opportunity.
- An existing `participant-tool-registrar` Spawn-schema test expects wording absent from the baseline description (`Omit template and config` versus `Inherit the completed parent conversation...`). This unrelated assertion remains unchanged and is excluded from the passing focused registrar run.

## Outcomes and retrospective

Implemented the agreed attention model, all/selected Wait with suffix references, Agent-owned outbound dependencies, freely targeted delivered unresolved Answers, ordinary terminal Answer receipts, and neutral nonduplicating continuation. Maintained docs/glossary and task-owned tests now use the corrected semantics. Unrelated runtime repair commits remain intact; their temporary Answer presentation metadata allowance is retired with the producer it supported.
