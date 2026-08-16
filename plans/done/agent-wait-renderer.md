# Show Agent Wait participants and Answers

This ExecPlan is a living document. Keep Progress, Surprises & Discoveries, Decision Log, and Outcomes & Retrospective current while implementing.

## Purpose / Big Picture

An executing `agent_wait` row should identify the Agents whose outstanding Requests are in its fixed snapshot. When the join completes, the same row should replace that progress view with the returned Answers, attributed to their responders. This makes a parked fan-in understandable without expanding raw protocol JSON.

## Progress

- [x] Inspect the current Agent Wait, Agent Message, renderer, and child Control seams.
- [x] Add observable renderer tests for waiting identities and attributed Answers.
- [x] Publish the admitted Wait snapshot as volatile progress for local and process-hosted participants.
- [x] Render progress and final Answers with the same header/body projection used by direct Answer Delivery.
- [x] Validate focused renderer/Control tests, typecheck, diff hygiene, and the fast suite.
- [x] Move this plan to `plans/done/`.

## Surprises & Discoveries

- `agent_wait` is parameterless, so its call renderer cannot know the selected Request targets.
- Pi supports partial tool-result updates through `onUpdate`; the exact coordinator-owned snapshot can therefore remain out of model input while becoming visible in the TUI.
- Process-hosted participants require a typed owner-to-child Control event to carry the same volatile progress.
- Answer slots already delivered through the ordinary Delivery path intentionally omit their body. The Wait renderer attributes these from row-local progress when available and says “Answer already delivered” instead of duplicating content.

## Decision Log

- Treat Wait progress as volatile presentation data, not durable Agent Wait result evidence.
- Publish the exact fixed snapshot only after admission; do not infer targets independently in the renderer.
- Keep the default result compact and render each delivered Answer through the direct Message Delivery projection module rather than emulating an `agent_message` tool receipt.

## Context and Orientation

`src/coordination/agent-waits.ts` owns snapshot admission. `src/tools/participant-coordination-tools.ts` bridges coordinator handlers to Pi tool updates. `src/tools/coordination-renderers.ts` renders Wait. `src/tools/message-delivery-renderer.ts` owns the `[Answer] from …` header/body presentation for model-visible Answer Delivery. Remote children invoke coordination through `src/process-runtime/remote-participant-control.ts`; schemas and events live in `src/control/agent-control-protocol.ts`, and `src/process-runtime/child-runtime-bridge.ts` receives owner events.

## Plan of Work

Define a small `AgentWaitProgress` shape containing the canonical Request identities and responder Agent identities. Extend the internal Wait handler with an optional progress observer. Publish once from the coordinator immediately after its non-empty snapshot is fixed.

For owner-local tools, forward the observer directly to Pi `onUpdate`. For child tools, register the observer around the pending Control request and route a new typed owner-to-child event by tool-call identity. The event is presentation-only and is removed when the request settles.

Teach the Wait result renderer to persist the latest progress in row-local renderer state and show formatted Agent identities while partial. Extract the reusable single-message projection from Message Delivery and compose one projection per newly delivered Wait Answer after completion.

## Validation and Acceptance

The renderer test must demonstrate labeled compact identities during a partial Wait and attributed Answer text after completion. Handler tests must show the progress callback receives the exact admitted snapshot. Remote adapter and Control schema tests must prove process-hosted progress routing. Existing Agent Wait behavior must remain unchanged.

Run focused tests first, then `npm run typecheck`, `git diff --check`, and `npm run test:fast`.

## Idempotence and Recovery

Progress events are volatile and may be repeated without protocol effects. Event subscriptions are keyed by tool-call identity and removed in `finally`, so interruption and Control failure cannot leave stale observers. Re-running tests and validation commands is safe.

## Outcomes & Retrospective

Agent Wait now publishes its exact admitted Request/responder snapshot as a partial tool update. While parked, the row shows the Answer count and compact labeled responder identities. Completion replaces the progress view with one `[Answer] from …` header/body block per newly delivered snapshot slot; collapsed and expanded bodies use the direct Message Delivery implementation, and expanded Wait rendering also includes protocol details. The stable call header is only `wait`, leaving all changing state to the result renderer.

The progress path works both in the Owner Runtime and across child process Control through a closed, typed `coordination.wait.progress` event. Child subscriptions are keyed by tool-call identity and removed when the pending Control request settles.

Validation passed: focused renderer, participant registrar, remote Control, Control schema, Agent Wait behavior, Message renderer, extension conformance, and real Pi child-process Runtime tests; TypeScript typecheck; diff hygiene; and the complete fast suite.
