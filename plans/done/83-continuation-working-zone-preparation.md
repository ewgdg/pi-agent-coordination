# Continuation working-zone preparation

## Goal

Implement issue #83 and ADR 0003. An `agent_message` Request may carry immutable, non-model-visible `contextPreparation` intent. When that Request reaches an idle reused Agent, the child Turn Compaction Gateway may call the recipient's active public compaction strategy once before committing the exact Delivery.

## Intention

Keep one admission mechanism. The Workflow side transports the committed intent with the scheduled Request, while the child-local Turn Compaction Gateway owns the policy calculation and the only proactive compaction attempt.

The Request projection remains unchanged. Preparation affects neither routing nor Delivery identity. The exact transcript commitment remains the only Delivery proof.

## Scope and constraints

- Add `contextPreparation` only to `agent_message` operation `request`.
- Require both `workScale` and `contextDependence` when the object is present.
- Resolve metadata from the committed source. Retry reuses the committed Request and cannot replace it.
- Carry the metadata beside scheduling and Runtime Delivery data, never inside `ModelVisibleMessage` or Delivery JSON.
- Skip proactive preparation when omitted, automatic compaction is disabled, current usage is unavailable, the recipient is active, or the Delivery uses active Steer semantics.
- Use the decimal thresholds and runway formula from issue #83.
- Unknown thinking or unavailable runway inputs use the dependence-cost threshold without adjustment.
- Cache state has no policy input.
- Call public `session.compact(customInstructions)` no more than once for one exact Request admission. Do not inspect extension identity or select a compaction strategy.
- Prospective Request guidance may influence retention of existing context. It must tell summarizers not to include, paraphrase, or claim receipt of the uncommitted Request.
- Cancellation and Runtime-generation invalidation must fence Delivery after every preparation await.
- Optional preparation failure below Pi's native threshold warns in the child and continues without another attempt. Native-threshold behavior remains blocking.
- Do not add production telemetry, protocol lifecycle events, cooldown state, or threshold memory.

## Work plan

### 1. Pure policy, test first

1. Add a focused policy test matrix covering every work scale, dependence level, and thinking level.
2. Prove formula bounds and monotonicity, including representative 128k, 200k, and 1M windows.
3. Add a small pure policy module that returns the effective threshold or a clear skip decision from explicit inputs.

Checkpoint: policy tests pass without changing message delivery.

### 2. Immutable Request contract

1. Extend the `agent_message` request schema, TypeScript input, exact validation, equality, rendering expectations, and committed `Message` request metadata.
2. Add protocol tests for required paired estimates, request-only availability, source equality, omission, and retry reuse.
3. Keep `createMessageDeliveryItem()` and the recipient's model-visible projection unchanged.

Checkpoint: committed preparation intent is recoverable from the source but absent from Delivery content.

### 3. One process-backed vertical path

1. Add optional preparation metadata to `ScheduledMessageDelivery` and `AgentRuntimeDelivery`, then serialize it through the existing child Control `message.deliver` request.
2. Populate it only from ordinary committed Requests. Spawn Creation Requests and all other Messages omit it.
3. At idle custom Request admission, pass metadata plus the exact model-visible incoming Request estimate to the Turn Compaction Gateway.
4. Have the gateway read current public session usage, model context window, thinking level, and current compaction settings, apply the pure policy, and call `session.compact(customInstructions)` once before dispatch.
5. Add a process-backed regression that proves compaction precedes exact Request transcript commitment and model start.

Checkpoint: one real Request crosses protocol, scheduling, child preparation, transcript commitment, and model start in the required order.

### 4. Failure, strategy, and ordering cases

1. Test omitted intent and user-disabled automatic compaction.
2. Test active Steer preservation and no proactive attempt.
3. Test cancellation during preparation and Runtime-generation fencing.
4. Test prospective relevance instructions and ensure the uncommitted Request is excluded from the summary instruction.
5. Test an extension-provided compaction result without strategy-specific code.
6. Distinguish optional below-native preparation failure, which warns and delivers, from native-threshold failure, which keeps existing blocking behavior.
7. Prove at most one proactive attempt per exact admission and fresh recomputation for later Requests.

Checkpoint: all acceptance races and compaction contracts have observable coverage.

### 5. Guidance and docs

1. Update the shared Agent Delegation guide once so both Message and Spawn surfaces explain reuse versus fresh spawn.
2. Update `docs/agent-messaging.md` and `CONTEXT.md` only where needed to state the implemented Request and gateway behavior.
3. Keep the ADR as the decision record and avoid duplicating obsolete alternatives.

## Validation

Targeted gates during development:

```text
node --test tests/working-zone-preparation-policy.test.ts
node --test tests/message-tool.test.ts tests/message.test.ts tests/agent-request.test.ts
node --test tests/control-protocol-schemas.test.ts
node --test tests/pi-child-process-runtime.test.ts
npm run typecheck
```

Final gates:

```text
npm run test:fast
npm run test:process
npm run test:conformance
npm run typecheck
git diff --check
```

Run the full process and conformance gates only after targeted policy, protocol, and process tests pass.

## Progress

- [x] Read issue #83, ADR 0003, the issue #82 gateway plan, and current gateway implementation.
- [x] Created this ExecPlan before implementation.
- [x] Locked the policy with a complete enum/thinking matrix, monotonicity and bound checks, and 128k, 200k, and 1M examples.
- [x] Carried immutable Request preparation intent without changing the model-visible projection; retry reconstructs the committed intent.
- [x] Completed process-backed paths through initial protocol admission, retry scheduling, child preparation, extension-owned compaction, exact transcript commitment, and model start.
- [x] Covered cancellation, Runtime-generation fencing, active Steer, disabled compaction, unknown usage, strategy guidance, optional failure, native-threshold behavior, and per-admission attempt count.
- [x] Updated the shared Message/Spawn delegation guide and Agent messaging documentation.
- [x] Passed fast, process, conformance, typecheck, and diff checks.

## Decisions

- Extend `ChildTurnCompactionGateway`; do not add a second admission lane.
- Keep preparation metadata on the coordination/Runtime envelope, outside `ModelVisibleMessageDelivery`.
- Keep the policy calculation pure and independent of Pi objects.
- Estimate only the exact model-visible Request projection passed to the recipient. The estimator choice will be documented after confirming the public Pi tokenizer/API available in 0.84.0.

## Surprises and discoveries

- Pi's public `estimateTokens()` estimates exactly the custom Request projection used for `Q`; no tokenizer or provider-specific branch is needed.
- `session.compact(customInstructions)` is a forced manual call, so the gateway must explicitly check both automatic compaction state and current settings before using it for preparation.
- A public compaction call uses the active `session_before_compact` strategy unchanged. An extension result persists and resumes Delivery without strategy identity checks.
- Pi reports `Nothing to compact (session too small)` and `Already compacted` as errors even though the existing native-threshold gateway treats them as no work. Prepared Requests preserve that behavior at the native threshold; other native-threshold failures remain blocking.
- The process-backed retry path proved that no separate durable preparation record is needed. Re-resolving the canonical Request source restores the same metadata before scheduling.
- The first complete process gate exceeded a five-minute command timeout without reporting a failure. Re-running with a ten-minute command allowance completed successfully.

## Outcomes and retrospective

The implementation kept the Turn Compaction Gateway as the only child admission mechanism. Preparation intent remains on the scheduling and Runtime envelope, while the model-visible Request JSON is unchanged. The child computes the threshold from current public session state, makes one public strategy call when required, then reuses the existing cancellation checkpoints and transcript observer.

The pure policy module made the formula reviewable without Pi fixtures. One coordinator process test covers canonical retry reconstruction and scheduling, while one direct child process test covers the harder timing cases: omitted metadata, active Steer, optional failure warning, cancellation during compaction, extension-owned results, instruction content, and exact compaction-before-Delivery order.
