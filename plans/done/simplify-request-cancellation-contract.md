# Simplify Request Cancellation contract

## Goal

Make `agent_message` cancellation unambiguous and remove redundant identifiers from cancellation receipts.

## Intention

The call names the target Request once as `requestMessageId`. The receipt reports only the Message created by the call, or the existing Answer/Cancellation Message that won the race.

## Scope & Constraints

- Rename only Request Cancellation input from `requestId` to `requestMessageId`.
- New Cancellation receipts contain `messageId` plus delivery outcome.
- `already_cancelled` contains only `disposition` and `cancellationMessageId`.
- `already_answered` contains only `disposition` and `answerMessageId`.
- Keep internal Request relationship terminology and Answer input/receipt contracts unchanged.
- Do not retain legacy aliases.
- Preserve the pending schema-rejected-call fix already in the worktree.

## Work Plan

1. Change public cancellation behavior tests and observe failure.
2. Change cancellation input validation/schema and correlation logic.
3. Simplify cancellation receipt types, protocol schemas, coordinator results, and renderer.
4. Update remaining cancellation tests and user-facing messaging documentation.
5. Run targeted tests, typecheck, then broader affected suites.

## Validation

- Cancellation tool-schema and registered-tool tests.
- Agent Request behavioral suite.
- Control protocol schema tests.
- Operational Incident cancellation tests.
- TypeScript typecheck.

## Progress

- [x] Contract and public test seam confirmed.
- [x] Red test captured the old cancellation input type.
- [x] Implementation completed.
- [x] Documentation updated.
- [x] Targeted and affected-suite validation completed.

## Decisions

Cancellation Delivery projections retain their internal correlation fields because they are standalone durable evidence. This change is limited to tool input and immediate receipts.

The process Control endpoint uses one response union for every `agent_message` operation. It retains Answer race receipt variants while adding the disjoint cancellation variants; the cancellation coordinator and its TypeScript result type do not emit the old redundant cancellation receipts.

## Outcomes & Retrospective

Cancellation calls now use `requestMessageId`. New Cancellation receipts contain only their `messageId` and Delivery outcome. Existing-resolution receipts contain only `answerMessageId` or `cancellationMessageId` with their disposition. No legacy cancellation input or output alias remains in the public implementation.

Validation passed: typecheck, all 12 Agent Request tests, all 25 Message tests, cancellation-focused Operational Incident and Run Supervision tests, Control schema tests, tool renderer tests, participant/control adapter tests, Owner Fork tests, and the schema-rejected-call regression. The complete Run Supervision file did not terminate within 90 seconds after its 18 tests had printed progress; its affected cancellation test passed independently.
