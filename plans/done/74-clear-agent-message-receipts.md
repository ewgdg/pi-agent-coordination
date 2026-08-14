# Clear Agent Message and Spawn receipts

## Goal

Replace model-facing `pending` receipt language with consistent Message send and Spawn outcomes so an Agent understands that Request work is asynchronous and does not repeat it.

## Intention

Use one Message send vocabulary for ordinary Messages, Agent Requests, and Spawn's Creation Request. Keep child creation separate. Put stable detached-delegation behavior in one shared Pi prompt guideline instead of repeating prose in every result.

## Scope & Constraints

- Rename public Request correlation identity to `requestMessageId` consistently.
- Use `messageStatus: "sent" | "not_sent" | "unknown"` for immediate asynchronous send outcomes.
- Use `spawnStatus: "created" | "not_created" | "unknown"` for child creation.
- A normal Request and Spawn's Creation Request use the same Message status language.
- Keep exact failure stages and effective configuration where currently available.
- Add one shared `<agent_tools>` prompt guideline to `agent_message` and `agent_spawn`; rely on Pi's exact-string guideline deduplication.
- Do not preserve the old receipt fields or model-facing `pending` values.
- Do not add or test TUI renderer changes in this task. Keep validation to fast tests plus typecheck.

## Public Test Seams

1. Model tool interface: the shared prompt guideline appears once and tool metadata remains role-correct.
2. `agent_message` execution: ordinary Message and Request receipts expose the new identity/status shapes.
3. `agent_spawn` execution: success, confirmed partial failures, pre-identity failure, and confirmation loss expose the new shape.
4. Control transport schemas accept the new public receipts and reject removed shapes.

## Work Plan

1. Add one failing fast test for shared prompt guidance and make it pass.
2. Add failing Message/Request receipt tests, then replace receipt vocabulary and Request identity naming.
3. Add failing Spawn receipt tests, then replace Spawn receipt vocabulary.
4. Update the Control schema and focused schema tests.
5. Remove obsolete assertions/usages from fast tests and update protocol documentation/glossary.
6. Run focused tests, `npm run test:fast`, typecheck, and diff hygiene.

## Validation

- Focused Node test files only during red/green cycles.
- `npm run test:fast`
- `npm run typecheck`
- `git diff --check`

## Progress

- [x] Public test seams confirmed; TUI rendering excluded.
- [x] Shared prompt guideline slice.
- [x] Message and Request receipt slice.
- [x] Spawn receipt slice.
- [x] Control schema slice.
- [x] Documentation and final validation.

## Surprises & Discoveries

- `requestMessageId` had previously been adopted only for Cancellation input. Answer input, receipts, and model-visible Request/Answer/Cancellation Delivery projections still used `requestId`; all public Agent Request surfaces now use the one name.
- Pi 0.84 deduplicates identical `promptGuidelines` strings while assembling the system prompt, so both Request-bearing tools can own the same constant without duplicating the guide.
- Poll results retain evidence-specific dispositions such as `delivered`, `not_observed`, and `indeterminate`; only asynchronous send admission uses `messageStatus`.

## Decisions

- `requestMessageId` names the Request Message everywhere at the public interface.
- `messageStatus` is shared because an Agent Request is a specialized Message.
- `sent` means admitted for asynchronous Delivery and may still be queued; it does not prove Delivery.
- Stable behavior belongs in one shared prompt guideline, not receipt prose.

## Outcomes & Retrospective

Agent Message sending now reports `messageStatus: "sent" | "not_sent" | "unknown"`; Agent Requests return `requestMessageId`; Spawn reports child creation separately through `spawnStatus` and uses the same Creation Request Message status. The shared `<agent_tools>` guideline tells the model to continue only independent work or end the turn after a sent Request and not to poll merely to wait. Fast tests, typecheck, and diff hygiene pass; process/TUI suites were deliberately not run for this interface change.
