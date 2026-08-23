# Agent Message target selectors

## Goal

Let `agent_message` send and request operations identify a recipient by exact Agent label, full Agent ID, or unique Agent ID suffix. The caller should not need to retain a complete long identity. Ambiguous selectors must fail rather than routing arbitrarily.

## Intention

Resolve human-usable selectors once into the existing canonical full `targetAgentId`. Preserve the Message protocol invariant that an authored Message has one immutable recipient across retry, Run replacement, and cold recovery.

## Scope & Constraints

- Apply only to `agent_message` operations `send` and `request`.
- Keep the existing `targetAgentId` wire field; it accepts an exact label, full ID, or ID suffix.
- Resolve across all known Agents in the Workflow, matching current messaging authority rather than observation scope.
- Full exact ID wins immediately. Otherwise, combine exact-label and ID-suffix matches, deduplicate each Agent, and accept exactly one match.
- Reject blank, unknown, or ambiguous selectors before Message scheduling.
- Labels are not unique. Never select the first match.
- Persist the resolved full identity in durable author-result evidence when the caller used a selector, so later roster changes cannot retarget the Message.
- Do not change poll, retry, answer, or cancellation inputs.
- Avoid the full integration suite until targeted validation passes.

## Work Plan

1. Add failing behavioral tests for unique label and suffix resolution, ambiguous label/suffix rejection, exact-ID precedence, and canonical target reconstruction.
2. Add one reusable Agent target resolver at the coordination boundary.
3. Thread resolved identity into Message construction while retaining source-input equality checks.
4. Add durable resolved-target proof to author receipts/results for selector-authored Messages and teach transcript reconstruction to consume and validate it.
5. Update tool guidance/schema descriptions, rendering where needed, and `docs/agent-messaging.md`.
6. Run targeted message/request/protocol tests, typecheck, then the fast suite if the targeted blast radius is clean.

## Validation

- Unique exact label routes to that Agent.
- Unique suffix routes to that Agent.
- Duplicate exact labels reject with an ambiguity diagnostic.
- A suffix matching more than one Agent rejects.
- Exact full ID is accepted even if another Agent label happens to equal it.
- Retry/reconstruction uses the originally resolved full ID after a later matching Agent exists.
- Existing exact-ID send and request behavior remains unchanged.
- `npm run typecheck` passes.

## Progress

- [x] Inspected Message authoring, evidence reconstruction, tool schema, and Workflow roster seams.
- [x] Chosen a one-field selector API with canonical full-ID resolution.
- [x] Failing tests added.
- [x] Implementation complete.
- [x] Documentation complete.
- [x] Validation complete.

## Surprises & Discoveries

- The immutable Pi assistant tool call stores the caller's selector and cannot be rewritten after model output.
- Runtime routing queues are volatile. Resolving only during initial delivery would allow retry/cold recovery to retarget or become ambiguous after the roster changes.
- Native author tool results are already canonical Message evidence, making them the smallest durable place to bind a selector to its full Agent ID.
- Recipient Delivery must also recover the binding when Pi loses the author result.
- Result-less reconstruction cannot safely resolve a label while any relevant Agent evidence is quarantined, because the quarantined label is unavailable. Recovery fails closed with `evidence_unavailable` rather than retargeting.
- Requiring the canonical target across the Control response union also requires retry and newly-authored Cancellation scheduling receipts to carry `targetAgentId`; otherwise the shared response shapes cannot distinguish malformed author evidence from valid targetless retry results.

## Decisions

- Use the existing domain term `label` in documentation, while retaining the public `targetAgentId` field requested for ID suffixes.
- Match labels exactly and case-sensitively; Agent IDs and suffixes are also exact strings.
- Exact full-ID lookup precedes label/suffix matching.
- Durable author-result or recipient-Delivery proof precedes current-roster resolution during reconstruction.
- Retry and newly-authored Cancellation scheduling receipts repeat the canonical target identity.

## Outcomes & Retrospective

`agent_message` now accepts exact labels, full IDs, and unique ID suffixes for `send` and `request`. Ambiguous selectors fail deterministically. The resolved full identity is persisted and validated through native receipts, reconstructed from recipient proof if result commitment was lost, and never silently retargeted around quarantine.

Validation completed:

- `npm run typecheck`
- `npm run test:fast`
- full `tests/message.test.ts`
- full `tests/agent-request.test.ts`
- targeted cold-recovery quarantine regression
- targeted Control-backed hosted/process Runtime tests
- independent review and re-review of durability, quarantine, schema, and protocol inspection
