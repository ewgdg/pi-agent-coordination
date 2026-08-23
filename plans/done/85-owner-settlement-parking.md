# Park Owner settlement while outbound Agent Requests remain

## Goal

Keep the Workflow Owner's native Pi session active while canonical outbound Agent Requests remain outstanding. Wake the existing Pi continuation only after turn-triggering input enters Agent core's steering or follow-up queue.

## Intention

The runtime, not the model, owns passive waiting. Pi must keep its normal continuation, retry, overflow recovery, compaction, transcript, and settlement behavior. Coordination adds one awaited low-level boundary and no transcript evidence.

## Scope and constraints

- Apply only to the Workflow Owner's in-process `AgentSession`.
- Install after `AgentSession` construction, behind Pi's own Agent listener, so Pi and extension `agent_end` work finishes first.
- Inspect canonical transcript evidence. Do not trust cached retention counts for the park decision.
- Park only successful low-level runs with no queued continuation.
- Race wake against the exact Agent abort signal and coordinator shutdown.
- Treat parking as settled-equivalent only for Message Delivery. Keep Pi and public Owner work state active.
- Observe successful `Agent.steer()` and `Agent.followUp()` calls once per session. Restore both methods when the session binding is disposed.
- Do not add tool calls, assistant messages, tool results, or durable wait records.

## Work plan

1. Add focused failing tests for the low-level parking boundary, queue observer behavior, non-waking input, abort, repeated parking, and extension ordering.
2. Add an Owner settlement parker that:
   - subscribes directly to Agent core,
   - derives success from the final assistant stop reason,
   - checks canonical outstanding Requests,
   - installs the queue waiter before closing the queue race with `hasQueuedMessages()`,
   - resolves without rejection on queue admission, exact-run abort, shutdown, or disposal.
3. Add a serialized parked Delivery boundary to `MessageDeliveryScheduler` and `MessageCoordinator`. Reconcile evidence and re-drain pending Deferred or Steer work on entry; allow later admissions to drain while parked.
4. Bind the parker to the authenticated Owner workflow and dispose it during replacement or shutdown. Keep child and Moderator paths unchanged.
5. Update model-facing guidance and owner messaging docs to tell Agents to end turns when no independent work remains and leave passive waiting to the runtime.
6. Add integrated Owner tests for Answer, reverse Request, ordinary Message, Deferred and Steer Delivery, human input, active custom messages, `nextTurn`, non-triggering custom messages, scheduler races, compaction, replacement, and one final native settlement. Add the Herdr-facing lifecycle integration proof where the existing test harness can observe it.

## Validation

- Run the new focused test file during development.
- Run affected Owner, Message Delivery, request, host-shape, extension conformance, and compaction tests.
- Run `npm run typecheck`.
- Run the fast suite once the focused tests pass. Avoid the full process suite unless the process-facing changes require it.

## Progress

- [x] Read issue #85, current Owner lifecycle, Pi 0.84 Agent/AgentSession internals, delivery scheduler, request evidence, and replacement behavior.
- [x] Add failing focused tests.
- [x] Implement Owner parking and Delivery integration.
- [x] Update guidance and docs.
- [x] Validate and review.

## Decisions

- Agent core's awaited listener is the parking mechanism because it blocks native `agent_settled` without changing Pi's post-run continuation.
- `RequestEvidence.residualRelationshipsFor(owner).awaitingAnswerRequestIds` is the canonical park predicate because it excludes cancellations and delivered Answers while retaining committed undelivered Answers.
- A scheduler-owned exact-Run parked map provides settled-equivalent Delivery without making `InProcessHostedRuntime.workState()` report idle.
- Queue admission is observed at `Agent.steer()` and `Agent.followUp()`, after the original synchronous enqueue succeeds. This covers human, coordination, and extension sources without source-specific wake logic.
- While parking keeps Agent core active, a custom extension message with neither `triggerTurn: true` nor active delivery is routed through Pi's `nextTurn` store. This preserves the result it would have had at native idle and prevents an accidental wake.

## Validation results

- `npm run typecheck`
- `npm run test:fast`
- Focused low-level parker and parked Delivery scheduler tests
- Process integration for Owner parking, delayed threshold compaction, Answer wake, non-triggering custom input, and final native settlement
- Affected process files: Agent Spawn, Message Delivery, Agent Request, Owner Workflow, Owner Bootstrap, Owner Fork, Agent View, and Human Request
- Independent review found and verified fixes for idle Deferred prompt deadlock, listener rejection, canonical entry recheck, and non-successful stop-reason bypass

## Outcomes and retrospective

The Owner now remains natively active while canonical outbound Requests remain. Delivery can use the parked exact Run without publishing Pi settlement, and Agent-core queue admission wakes Pi's existing continuation. The implementation adds no model-visible wait evidence. The main non-obvious constraint was that an idle Deferred Delivery's Promise includes the entire prompt and native settlement; parking must finalize it from transcript proof rather than await that Promise.

## Surprises and discoveries

- Pi's own Agent listener is registered in the `AgentSession` constructor and awaits every extension `agent_end` handler before returning.
- Pi checks retry, compaction, and queued continuation only after all Agent-core `agent_end` listeners finish. Parking there naturally delays threshold compaction but leaves overflow and retry behavior in Pi's existing path after wake.
- The current branch already contains #84's explicit Owner/child/Moderator execution roles even though GitHub still reports #84 open.
- Pi routes every custom message sent while Agent core is active into a core queue, even when `triggerTurn` is false. Parking therefore needs a narrow non-triggering custom-message adapter in addition to the shared queue observer.
- An idle Deferred Delivery owns the complete Pi prompt Promise, which resolves only after native settlement. At a later parking boundary the scheduler must use already-committed Delivery proof instead of awaiting that Promise, or the Agent listener and prompt Promise deadlock each other.
