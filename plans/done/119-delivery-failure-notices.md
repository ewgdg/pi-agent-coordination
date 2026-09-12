# Notify authors of asynchronous Delivery failures

## Goal and intention
An admitted Message must not fail silently for its author. Notify the author without treating scheduling or transport errors as proof of non-Delivery, and leave recovery choices with the model.

## Scope and constraints
Correlated runtime input for ordinary Messages and Requests; deduplicate a scheduling attempt, recheck recipient proof before dispatch, respect Agent Wait, interruption holds and shutdown. No automatic retry, replacement Message or Request resolution. Existing Delivery Stall moderation remains independent.

## Work plan
1. Add focused scheduler/coordinator tests for post-admission failure, proof races, retry and author lifecycle.
2. Track admitted scheduling attempts and emit one failure event per attempt.
3. Schedule a model-visible author notice through the existing custom-delivery path, including evidence and explicit recovery guidance.
4. Test process transport rejection/loss, document behavior, typecheck and run focused regression suites.

## Validation
Use short deterministic Runtime Host fixtures with real transcript commitment, plus targeted process-runtime tests. Do not run the full integration suite.

## Progress
- Inspected scheduler progress, custom delivery/Wait preemption, Message admission/evidence, child dispatch completion and existing tests.
- SDK documentation confirms prompt completion may outlive admission and queued input; transcript proof remains authoritative.

## Progress checkpoint
- Added regression tests first; missing notice behavior failed before implementation.
- Implemented admitted-attempt failure tracking and model-visible author custom input. Connected protocol transport schema and transcript inspection (notices do not count as Message Delivery).
- Found an enabling scheduling defect: dispatch rejection before native turn startup can have no settlement event. The rejected completion now fences only the exact current Run with the still-owned, unproven reservation, allowing explicit retry without duplicate dispatch.
- Focused coordinator/scheduler/Wait suites: 63 passing before adding Control-backed scenarios. Added child dispatch rejection, Control closure, process exit and commitment-before-loss through the real hosted-runtime adapter with deterministic transport fixtures; 19 notice tests pass. Typecheck passes.

## Outcomes and validation
- 22 failure-notice cases pass: Message/Request correlation, explicit retry/proof dedup, repeated observations and new failures, held/active/settled/dormant/waiting authors, late proof, initial non-admission, shutdown and queued-author termination, unavailable evidence, sync/async dispatch rejection, and Control-backed transport loss/process exit including committed Delivery.
- `node --test --test-timeout=5000 tests/delivery-failure-notice.test.ts tests/failed-delivery-observation.test.ts tests/owner-parked-delivery-scheduler.test.ts tests/wait-request-recovery.test.ts tests/control-protocol-schemas.test.ts tests/message-delivery.test.ts tests/moderator-reminder-admission.test.ts`: 97 passing.
- `node --test --test-name-pattern='unexpected real child' tests/pi-child-hosted-runtime.test.ts`: 2 real child channel-loss/process-kill cases pass.
- `npm run typecheck` and `git diff --check`: pass.
- Full integration suite deliberately not run. No external API or process-runtime implementation changes needed: existing child-correlated completion and transport-loss handling feed the scheduler failure boundary.
- Documented scheduling, evidence semantics, process-local notification dedup, explicit recovery choices, and relationship to Delivery Stall moderation / Request Wait reconciliation in `docs/agent-messaging.md`.
