# Join outstanding Agent Answers

## Goal

Make settling the default asynchronous coordination flow and simplify `agent_wait` into a parameterless strict fan-in operation over every outstanding Agent Request authored by the caller.

## Intention

Agents should not manage protocol identities merely to join their own work. `agent_wait` should expose one deliberate operation: park only when one next decision requires every outstanding Answer together. Otherwise the Agent should settle and let Answer Delivery reactivate it normally.

## Scope & Constraints

- `agent_wait` accepts exactly `{}`.
- Each committed sequential call snapshots the caller's outstanding outbound Agent Requests when it begins execution, after preceding calls in the same tool batch have committed their results.
- The snapshot includes unanswered Requests and committed Answers lacking requester-side Delivery proof.
- It excludes cancelled Requests and Answers already delivered to the requester.
- Snapshot order is canonical Request authoring order; Request sources after the Wait call in the same tool batch and later Requests are not added.
- A caller with no outstanding Requests fails fast.
- Preemption consumes no Answer Delivery. A later call takes a fresh outstanding snapshot.
- Ordinary Messages do not satisfy Requests.
- Preserve existing suspension, execution-capacity release, Answer retrieval, direct-Delivery arbitration, exact-Run fencing, and wait-preemption behavior.
- Remove explicit-selection behavior rather than retaining a compatibility path.
- Prompt guidance remains advisory: it explains that Agent Wait is designed to join Answers and recommends settling when Answers can be handled independently.

## Confirmed Test Seams

The user confirmed the existing public seams:

1. Registered `agent_wait` schema and model-facing prompt guidance.
2. Role-bound coordinator behavior backed by committed Pi transcripts.
3. Native wait results and Answer Delivery proof.
4. Observable Run suspension, preemption, and execution-capacity behavior.
5. Process Control request/response schemas and remote participant adapter.

Tests observe registered tool metadata, transcript evidence, coordinator results, and Run behavior rather than private waiter state.

## Work Plan

1. Make the prompt-intent conformance test green with advisory settle-versus-join wording.
2. Replace the public wait schema/input test with a red parameterless-interface tracer.
3. Add a red transcript-backed tracer that proves one call joins all outstanding Requests, preserves authoring order, skips already delivered/cancelled Requests, and rejects an empty snapshot.
4. Resolve and freeze the outstanding-Request snapshot when the committed sequential Wait begins execution, then route those identities through the existing wait machinery.
5. Remove explicit Request identity inputs from tool, Control, process adapter, protocol validation, rendering, and coordinator interfaces.
6. Update preemption and successor-call tests for fresh outstanding snapshots.
7. Update domain language and Agent messaging documentation, including fan-out/fan-in and reverse-Request examples.
8. Run focused tests, typecheck, fast tests if warranted, diff hygiene, and targeted process coverage.

## Validation

- Focused participant registrar, Request resolution, Agent Request, Control schema, remote participant, and renderer tests.
- `npm run typecheck`.
- `npm run test:fast` after focused tests pass.
- Targeted process tests only where the process seam adds behavior not covered in memory.
- `git diff --check`.

## Progress

- [x] Direction and public test seams confirmed.
- [x] Prompt conformance changed from whole-body matching to intent rules and committed red.
- [x] Advisory prompt guidance passes conformance.
- [x] Parameterless public tool interface passes.
- [x] Outstanding snapshot behavior passes.
- [x] Control/process and rendering surfaces pass.
- [x] Documentation and examples complete.
- [x] Final validation and review complete.

## Decisions

- Use a parameterless interface instead of overloading an empty array.
- Remove partial joins until a concrete use case requires them.
- Treat each call as a fixed snapshot, never a continuously growing quiescence wait.
- A fresh call after preemption recomputes the outstanding set.
- Reject a zero-Request snapshot rather than silently succeeding.
- The completed native result durably materializes the live snapshot. Reinspection verifies that every returned Request was caller-authored before the Wait and preserves source order; the live coordinator and public behavior tests enforce snapshot completeness because the parameterless call contains no identity list.

## Surprises & Discoveries

- Existing tests contain no concrete partial-join use case; production behavior currently pays interface and validation complexity for unused selection flexibility.
- Sequential sibling tool results append after their shared assistant source. Snapshot membership therefore uses source order for Request authorship but current requester-side Delivery proof when the Wait begins execution; otherwise a preceding retry in the same batch is incorrectly joined again.
- Cancelling the unscheduled Creation Request in wait-focused tests can itself activate the child. The shared test helper waits for that cancellation turn to settle before installing scenario-specific model responses.
- A parameterless call cannot carry its resolved snapshot as author input. The native successful result materializes that snapshot durably; transcript reinspection verifies caller authorship, pre-Wait source order, and exact slot ordering, while the live coordinator retains the frozen IDs through result commitment.

## Outcomes & Retrospective

`agent_wait` now accepts only `{}` and joins every Request still outstanding when the sequential call begins execution. The coordinator freezes canonical source-ordered identities once, excludes cancellations and requester-side Answer proof already present—including proof committed by a preceding sibling tool—and rejects an empty snapshot. Later Request sources do not enter the frozen set.

Prompt guidance treats waiting as a soft strict-fan-in optimization: continue independent work and settle by default, use Wait when one next decision needs the complete Answer set, and let reverse Requests preempt the join without consuming Answer Delivery. Documentation includes both fan-out/fan-in and interactive reverse-Request examples.

Validation passed: focused Agent Wait lifecycle/race tests, protocol proof tests, participant/Control/process-adapter tests, Agent Spawn/runtime-preparation coverage, TypeScript typecheck, diff hygiene, and the complete fast suite. Targeted process execution was unnecessary because the changed Control payload is fully covered by the process-neutral schema and remote-adapter seams.
