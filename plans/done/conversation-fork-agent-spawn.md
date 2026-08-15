# Add cache-affine conversation forks to Agent Spawn

## Goal

Let an ordinary Agent opt into `agent_spawn({ conversation: "fork" })` so its child begins from the spawning request's last complete parent conversation context while remaining a fresh same-Workflow Agent with isolated current coordination authority.

## Intention

Treat a conversation fork as a prompt-lineage continuation, not as configurable context copying. Preserve the parent's completed model prefix for first-request cache affinity, append one fresh child Identity as the protocol-evidence cutoff, and make the inherited authorship boundary model-visible only after that prefix. Keep existing context-isolated configurable Spawn as the default.

## Scope & Constraints

- Add optional top-level `conversation: "fork"`; omission retains current isolated Spawn.
- Reject a fork combined with `template` or `config` before Identity commit. `request`, `label`, and `description` remain valid.
- Resolve the canonical `agent_spawn` source and copy only the parent's active path through the parent of its containing assistant entry. Never copy the incomplete assistant tool-call entry or sibling tool calls/results from that batch.
- Create a fresh child Pi session/Agent identity in the same Workflow with the caller as immutable Direct Spawner.
- Append the ordinary child Identity after the copied prefix. The matching session/Runtime/Control identity remains authoritative; this entry is only the current coordination-evidence cutoff.
- Treat all pre-cutoff Identities, Messages, Requests, Deliveries, and authority as historical model context. They create no current Message visibility, relationship, or Answer obligation.
- Append one model-visible inherited-conversation handoff after the Identity and before the ordinary Creation Request Delivery. It must explain prior authorship and the authority cutoff without changing the copied prefix.
- For the first child request, inherit the live parent's current resolved model, thinking, cwd, resources, and prompt-relevant tool surface without caller Template/configuration overrides. This makes the request cache-affine, not a guaranteed cache hit.
- Preserve current receipt commitment boundaries, fixed-Deferred Creation Request behavior, process isolation, dynamic successor Runtime preparation, and trust-based protocol design.
- Do not add configurable copied-context modes, summaries, migration compatibility, or cache-hit claims.
- Existing Owner Fork remains a fresh independent Workflow; conversation-fork Spawn remains a child in the same Workflow.

## Public Test Seams

The user confirmed these public seams when approving the settled contract and starting implementation:

1. Strict `agent_spawn` tool schema/input validation for fork/configuration exclusivity.
2. Real hosted `WorkflowCoordinator` Spawn behavior using Pi sessions: exact completed-context prefix, fresh Identity cutoff, model-visible handoff, and ordinary Creation Request.
3. Child provider-visible first request: inherited conversation and cache-affine parent model/prompt/tool inputs without the incomplete spawn tool call.
4. Public coordination tools after fork: copied Agent/Message/Request evidence grants no current authority or obligation.
5. Durable transcript reopening and cold-host recovery for a child Identity following an inherited prefix.
6. Existing public Spawn receipts across pre-Identity, committed, and uncertain boundaries.

## Work Plan

1. Add a failing input/tool-contract slice for `conversation: "fork"` and mutual exclusion with `template`/`config`; implement only the canonical input surface.
2. Add a failing durable transcript slice proving a fork copies the exact completed active prefix and appends a matching child Identity cutoff; implement staged fork transcript creation and generalized child Identity validation/materialization.
3. Add a failing real process/provider slice proving the first child context contains the inherited conversation, post-prefix handoff, and Creation Request but excludes the in-flight spawn assistant entry; implement first-Run preparation and handoff projection.
4. Add a failing authority/recovery slice proving copied coordination is inert and cold recovery validates the forked child; implement cutoff-aware discovery and recovery.
5. Update `CONTEXT.md`, Agent Spawn/Recovery documentation, prompt/tool description, and focused conformance expectations.
6. Run focused tests and typecheck throughout. At completion run the fast suite, targeted process suite, `git diff --check`, and two-axis review against pre-work `12399b9`; address only findings within this feature contract.

## Validation

- Focused protocol/input tests.
- Focused `tests/agent-spawn.test.ts` slices.
- Focused process-child/provider test proving model context.
- Focused cold-host recovery tests.
- `npm run typecheck` during implementation.
- `npm run test:fast` when focused fast tests pass.
- Targeted process tests only; the full integration suite is intentionally avoided unless blast radius proves broad.
- `git diff --check`.
- Standards review against `AGENTS.md`, `CONTEXT.md`, relevant completed plans/docs, and pre-work `12399b9`.
- Specification review against this settled contract and the user discussion.

## Progress

- [x] Settled product and protocol contract with the user.
- [x] Confirmed public test seams and implementation start.
- [x] Implement strict public input contract.
- [x] Implement durable completed-context fork and Identity cutoff.
- [x] Implement model-visible handoff and first-request cache affinity.
- [x] Implement recovery and copied-evidence isolation.
- [x] Document, validate, review, and complete the plan.

## Surprises & Discoveries

- `agent_spawn` runs after Pi commits its assistant tool-call entry but before its tool result exists. The only provider-valid reusable prefix ends at that assistant entry's parent.
- Pi custom Identity entries do not participate in model context. Protocol identity and model awareness therefore require separate projections.
- The pre-work `agent-spawn.test.ts` expected allowed-tool lists omit `agent_wait`, while pre-work Runtime preparation already includes it. The focused file therefore has two unrelated baseline failures; do not fold that stale expectation cleanup into this feature silently.
- The parent's dynamic Agent Template catalogue appears as a `before_agent_start` system-prompt suffix, while the first process child request currently lacks that suffix because custom Message Delivery does not traverse that prompt hook. Conversation messages and the active tool surface remain affine, but exact whole-prompt cache equality is not currently achievable without expanding scope into dynamic prompt propagation; retain the explicit no-hit-guarantee contract.
- Cold recovery must validate the historical source branch, not the parent's later active branch. A parent may branch away after creating a valid fork without revoking that child.
- Review reproduced a same-source concurrent Spawn race already present at pre-work `12399b9`: the source claim is written only after asynchronous preparation. This feature does not worsen it. Fixing that unrelated existing bug requires separate user approval and coverage.

## Decisions

- Use the top-level literal `conversation: "fork"`; absence remains isolated. Do not add an explicit `"isolated"` value with no behavior.
- Reject both Template and explicit Spawn Configuration for a fork. Templates are configuration inputs and would defeat the same contract indirectly.
- Preserve cache affinity by appending child-specific awareness after the copied prefix rather than prepending it through the system prompt.
- Keep the pre-existing same-source concurrent Spawn race out of this feature rather than silently expanding scope into an unrelated behavioral fix.

## Outcomes & Retrospective

Implemented one strict `conversation: "fork"` Spawn mode. The public schema and canonical validator reject Template/configuration combinations. Fork materialization copies the exact completed source branch into a same-directory hidden staging file, appends one fresh matching child Identity cutoff and one model-visible handoff, validates them, and atomically publishes the durable child transcript. The ordinary Creation Request and receipt boundaries remain unchanged.

First Runtime preparation reuses the live parent's model, thinking, cwd, resources, and exact active tool names while retaining the child's ordinary capability ceiling. Provider-visible tests prove the completed parent message/tool prefix, post-prefix handoff and Request, and exclusion of the in-flight Spawn assistant entry. Public Message Poll, Agent Wait, and Agent Answer regressions prove copied Requests and Deliveries grant no child authorship, waiting authority, or Answer obligation.

Cold recovery now selects only the Identity/Moderator bootstrap matching the candidate session, validates context-isolated versus fork transcript shape, verifies one handoff and the exact historical parent source branch even after the parent branches away, and keeps pre-cutoff coordination outside current scope. A recovered-status regression proves historical Delivery evidence remains an obligation of the parent while the fork child has no corresponding retention reason.

Validation passed strict typecheck, `git diff --check`, the complete fast suite, 33 focused protocol/registrar/transcript/launch tests, and six focused process/recovery fork tests. The whole `agent-spawn.test.ts` file still has two pre-existing expected-tool-list failures because its baseline expectations omit `agent_wait` while pre-work Runtime preparation already includes it; this feature did not alter those lists.
