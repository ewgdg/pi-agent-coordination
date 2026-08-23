# Clarify Agent Message target addressing

## Goal

Rename the `agent_message` send/request selector input from `targetAgentId` to `targetAgent`, and reduce label ambiguity by resolving labels only within the caller's coordination neighborhood while keeping identity selectors Workflow-global.

## Intention

Make the public contract say what the value is: the caller supplies a selector, while receipts expose the canonical resolved `targetAgentId`. Treat labels as local human names and IDs/suffixes as global identities.

## Scope & Constraints

- Rename the send/request input field directly to `targetAgent`; do not accept or mention the removed input name as a compatibility path.
- Keep canonical Message fields and receipt fields named `targetAgentId` because they always contain a full identity.
- Resolution order:
  1. exact full Agent ID across the known Workflow;
  2. unique Agent ID suffix across the known Workflow;
  3. unique exact label inside the caller's coordination neighborhood.
- An ordinary Agent's label neighborhood is itself, its Direct Spawner, and its direct children.
- Owner and Moderator label neighborhoods contain the whole Workflow.
- Exact/suffix matching continues to account for identifiable quarantined IDs. Result-less reconstruction remains fail-closed when quarantine hides label evidence.
- Preserve durable author-result and recipient-Delivery target binding.

## Work Plan

1. Add failing resolver and tool-schema tests for local label scope, global suffixes, exact-ID precedence, and the `targetAgent` input shape.
2. Separate global identity candidates from scoped label candidates in the target resolver.
3. Compute the caller's label neighborhood from durable Agent relationships.
4. Rename the public input field through types, validation, committed-tool-call reconstruction, schema, renderers, prompt guidance, docs, and tests.
5. Run targeted protocol/message/request/control tests, typecheck, fast tests, and impacted process Runtime tests.

## Validation

- Two Workflow Agents may share a label when only one is in the ordinary caller's neighborhood.
- Duplicate labels inside the neighborhood reject.
- Owner and Moderator still see Workflow-global label ambiguity.
- Full IDs and suffixes resolve globally even outside the label neighborhood.
- `targetAgentId` is rejected as a send/request input property.
- Receipts continue returning canonical `targetAgentId`.

## Surprises & Discoveries

- Selector syntax is intentionally resolved by precedence rather than guessed intent: exact ID, then suffix, then scoped label.
- Durable recipient Delivery proof must precede current-roster resolution. Otherwise a later ID suffix can reinterpret a previously delivered label selector.
- The general quarantine set includes foreign-Workflow candidates. Messaging needs a narrower Workflow-candidate quarantine set so foreign IDs cannot create false suffix ambiguity.
- When Workflow quarantine hides label metadata, an unbound label cannot be proven unique and must fail with `evidence_unavailable`; exact IDs and suffixes remain resolvable from identifiable IDs.

## Decisions

- `targetAgent` exists only on send/request input. Canonical Message state and receipts retain `targetAgentId`.
- Ordinary label scope is exactly caller, Direct Spawner, and direct children. Owner and Moderator label scope is Workflow-wide.
- Recipient Delivery and persisted full-ID bindings are authoritative before live resolution.

## Outcomes & Retrospective

The public selector is now named `targetAgent`. Exact IDs and unique suffixes resolve across the Workflow; labels resolve only in the caller's coordination neighborhood. The removed `targetAgentId` input shape is rejected, while receipts still report the canonical full `targetAgentId`.

Validation completed:

- `npm run typecheck`
- `npm run test:fast`
- full `tests/message.test.ts`
- full `tests/agent-request.test.ts`
- targeted cold-recovery quarantine regression
- targeted Control-backed hosted/process Runtime tests
- independent review and re-review of scope, Delivery precedence, quarantine classification, and persisted binding validation

## Progress

- [x] Design agreed.
- [x] Failing tests added.
- [x] Implementation complete.
- [x] Documentation complete.
- [x] Validation complete.
