# Agent spawning

Every ordinary Agent can create one fresh child per `agent_spawn` call:

```ts
agent_spawn({
  request: "Inspect the failing integration and report the smallest safe fix.",
  template: "integration-researcher",
  label: "Integration researcher",
  description: "Investigates one integration failure",
  config: {
    cwd: "packages/integration",
    model: {
      id: "inherit",
      thinking: "high",
    },
    systemPrompt: "Reproduce the failure before proposing changes.",
    systemPromptMode: "append",
    loadContextFiles: true,
  },
})
```

`request` is required. `template`, `label`, and `description` are optional. Omit `conversation` for the default context-isolated child. Set `conversation: "fork"` to continue from the spawning conversation:

```ts
agent_spawn({
  request: "Explore an alternative from the completed conversation.",
  conversation: "fork",
  label: "Alternative",
})
```

A Conversation Fork cannot include `template` or `config`. Its first request inherits the live parent's model, thinking, cwd, resources, and active tool surface while preserving the completed message prefix for cache affinity; this does not guarantee a provider cache hit.

## Agent delegation

Every Creation Request delegates work and follows the shared [Agent Delegation](agent-messaging.md#agent-delegation) rules. Once its Answer arrives, the parent synthesizes it, performs necessary validation, and integrates the result.

For a context-isolated child, `config` may override the model/thinking pair, working directory, tool allowlist, skills, explicit system prompt, system-prompt mode, and native loading of trusted project instruction files such as `AGENTS.md` and `CLAUDE.md`. This context-file setting does not inherit the parent conversation. A `config.model` object requires both `id` and `thinking`; either may be `inherit` to use that value from the current parent Runtime. `id: inherit` with `thinking: inherit` is valid. Providing `config.model` bypasses Template model candidates entirely. `allowedTools` and `skills` replace their inherited selections, including with an empty array. Child extension selection is `inherit` or `none`; arbitrary per-child extension paths are not accepted.

Every Runtime shares the user's Pi configuration. The model and thinking pair resolved for a Spawn are explicit launch inputs only: preparing or starting the child must not persist them as user defaults. An explicit user preference action from an interactively selected Owner or child view updates the same shared configuration. Production child configuration must therefore not be isolated; tests that invoke persistent Pi APIs use an isolated fixture environment. See [ADR 0001](adr/0001-share-pi-user-configuration-across-agent-runtimes.md).

`allowedTools` is a capability ceiling, not an exact active-tool list. Pi and the selected extensions decide which allowed tools are registered and active, and may change their order during the Runtime. An allowed tool may therefore be unavailable or inactive. Role-required coordination tools are always added to the allowlist. Runtime startup rejects only an active tool outside the resolved allowlist.

The label resolves from the explicit label, selected template name, then `agent`. A description comes only from the explicit spawn input. Display metadata is trimmed, preserves Unicode, rejects line breaks and control characters, and is limited to 64 Unicode code points for labels and 240 for descriptions.

The authenticated calling Agent becomes the immutable Direct Spawner. Agent identity, Workflow membership, authority, role-required tool capabilities, and Creation Request delivery mode are not caller-supplied fields.

Every child receives a fresh durable Pi session and Agent identity. No resolved parent or child Runtime configuration is copied into its Identity. Its durable creation facts are display metadata, Workflow and Direct Spawner relationships, and a pointer to the canonical `agent_spawn` call. For a context-isolated Spawn, that call remains the sole source of the selected Template and explicit `config`, and the child does not inherit the caller's transcript, branch, model context, assembled prompt, editor state, or queued input.

A Conversation Fork instead copies the Direct Spawner's active transcript path through the parent of the assistant entry containing the canonical Spawn call. The executing assistant entry is excluded because its tool-result batch is incomplete. The fresh child Identity follows the copied prefix and cuts off current coordination evidence. Copied Identities, Messages, Requests, Deliveries, and authority remain historical model context only. A model-visible handoff after the cutoff tells the child that earlier actions belong to its Direct Spawner; the ordinary Creation Request follows.

Immediately before each new Runtime, the host resolves the current parent configuration. A live parent contributes its configured tool allowlist and current remaining Runtime state; a dormant parent is resolved recursively from the current Owner, current Templates, and canonical ancestor spawn inputs without starting those ancestors. The host then applies the child's current selected Template, explicit spawn configuration, role-required tool capabilities, current resources, trust, native project context-file loading, and explicit system prompt. The resulting launch specification is volatile and belongs only to that Runtime. The first preparation may be reused for the first process whose session header it created; successor and cold-recovered Runtimes always prepare again. A retained Runtime keeps its resolved configuration across its exact Runs.

Only canonical file-backed inherited extensions cross the process boundary. `extensions: "none"` excludes them. Pi-owned built-ins are reconstructed by the fresh Pi CLI. Arbitrary injected, anonymous, and named inline factories are process-local composition details and are not child inheritance inputs.

## Agent Templates

Templates are discovered recursively from these roots, lowest to highest precedence:

1. `<coordination-package>/agents/`
2. `<Pi-agent-directory>/agents/`
3. `~/.agents/agents/`
4. `<current-parent-runtime-cwd>/.agents/agents/` when that project is trusted

Discovery follows file and directory symlinks with canonical-path cycle prevention. A higher-precedence file replaces the whole lower definition. Same-precedence duplicates make that name unavailable, and a malformed named higher-precedence definition blocks lower fallback.

A Template is UTF-8 Markdown with required leading YAML frontmatter:

```markdown
---
name: integration-researcher
useWhen: Use for integration work requiring external documentation or source verification.
models:
  - id: anthropic/claude-sonnet-4-5
    thinking: high
  - id: deepseek/deepseek-v4-flash
    thinking: medium
skills:
  - research
extensions: inherit
systemPromptMode: append
loadContextFiles: true
---
Use primary sources and record exact reproduction evidence.
```

`name` is required lowercase kebab-case. Optional `useWhen` is nonblank text that tells a spawning Agent when to select the Template. Optional `models` is a nonempty ordered sequence of `id` and `thinking` pairs. The first model in Pi's current availability snapshot supplies both values, and preparation fails when none are available. Availability requires both a catalogue entry and configured provider authentication. Without `models`, an ordinary Agent inherits the parent model and thinking pair. A Moderator instead inherits the Owner model and lets Pi apply its shared default thinking level; a `moderator` Template with `models` explicitly selects both values. `systemPromptMode` defaults to `append`, and `loadContextFiles` defaults to `true`. The remaining frontmatter fields are `allowedTools`, `skills`, and `extensions`; `systemPromptMode` controls the explicit system-prompt channel; `loadContextFiles` controls native loading of trusted project instruction files such as `AGENTS.md` and `CLAUDE.md`. The Markdown body is the explicit child system prompt. Templates cannot define display metadata, working directory, the Creation Request, identity, authority, or lifecycle behavior. The reserved name `moderator` cannot be selected by ordinary `agent_spawn`.

Every spawning Runtime captures an Agent Template Catalogue Snapshot during admission or fresh Runtime Preparation. Resource reload replaces that Runtime's Snapshot. The Snapshot contains the currently valid Template catalogue. The active `agent_spawn` tool exposes it through prompt guidance; Pi owns ordinary system-prompt assembly, and coordination performs no per-Run Template discovery or system-prompt mutation. Runs in a retained Runtime reuse the same Snapshot between reloads.

Under the `Available Agent Templates Snapshot` heading, each prompt entry exposes its name, `useWhen` guidance, configured frontmatter values, and flat `model` and `thinking` fields for the first currently available pair. The configured fallback candidate list is not exposed. A Template whose configured candidates are all unavailable is omitted. This lets the Agent select a Template or deliberately override values through `agent_spawn.config` for a context-isolated Spawn. A Conversation Fork uses neither. Invalid and ambiguous Templates, Template source paths, discovery diagnostics, and Markdown system-prompt bodies are not exposed. The Snapshot is guidance only: every actual Spawn re-resolves the selected Template from current resources before preparing the child Runtime. Runtime Preparation also validates an explicitly overridden model against the current availability snapshot before committing the child Identity.

For every new Runtime, Template discovery is anchored to the current parent Runtime cwd. The per-spawn `config.cwd` resolves against that cwd and determines the prepared Runtime cwd. Pi applies its current project-trust decision there, and the child natively discovers permitted project instruction files such as `AGENTS.md` and `CLAUDE.md` when `loadContextFiles` is true. The explicit system prompt is passed independently with `--append-system-prompt` or `--system-prompt`; `loadContextFiles: false` passes `--no-context-files`. An untrusted project cannot contribute selected resources. Changes to ancestor Templates, resources, trust, or cwd can therefore affect a later descendant Runtime; they never mutate an already retained Runtime.

## Commitment and delivery

The committed native `agent_spawn` tool call is the Creation Request source. The child Identity append commits the child and Request together. For a Conversation Fork, the inherited prefix, child Identity, and model-visible handoff materialize atomically before the child becomes discoverable. After Identity commit, startup or scheduling failure never removes the child or Request.

The child starts a fresh Pi CLI/TUI process and admits its fixed-Deferred Creation Request into the same serialized incoming-Request lane used by ordinary [Agent messaging](agent-messaging.md). The Creation Request occupies the child's sole incoming Request slot after Delivery; later Requests to that child wait until it is answered or its Cancellation is delivered. A successful spawn receipt reports volatile admission; it does not claim that Delivery committed, the model processed the Request, or an Answer exists.

Confirmed Delivery admission failure releases the new child Run to dormant while preserving the committed child and Creation Request. Once Delivery commits, the Run remains retained while the child owes the corresponding Answer.

An admission exception before dispatch removes its abandoned scheduling item and releases an otherwise unretained child Run before reporting the error. Dispatched or proven Delivery keeps its existing reconciliation ownership. Explicit retry preserves the original Request identity and rechecks an undispatched pending item's eligibility; an existing dispatch reservation prevents duplicate Delivery.

After child Identity commit, the Creation Request uses the ordinary [Request protocol](agent-messaging.md): the Spawner can poll, retry, retrieve its Answer, or cancel; the child Answers through `agent_message`. The Answer fulfills one Request obligation and does not represent child completion or lifecycle state.

## Receipts

- `spawnStatus: "created"` with `messageStatus: "sent"` — the child and Creation Request exist, the first Run started, and the Request was admitted for asynchronous Delivery. It may still be queued and is not necessarily delivered.
- `spawnStatus: "created"` with `messageStatus: "not_sent"` — the child and Creation Request exist, but confirmed Run startup or Delivery admission failed. `failedStage` identifies that exact stage and `reason` reports the failure.
- `spawnStatus: "not_created"` — validation failed before child Identity committed. `failedStage` and `reason` report where and why.
- `spawnStatus: "unknown"` — confirmation was lost at a boundary where effects may exist. Candidate Agent and Request Message identities are returned when available.

Created and uncertain receipts include the effective runtime configuration only after it has resolved and passed resource validation. A created receipt returns `agentId` and `requestMessageId`; an uncertain receipt names them as candidates. Collapsed native rendering shows the Spawn and Message statuses, the Agent as `label · compact identity` using the final eight identity characters, model, thinking level, and any confirmed failure stage and reason. Expanded rendering identifies the Agent as `label · full identity`, followed by the exact structured receipt and effective configuration.

Repeating `agent_spawn` creates a sibling. Unfiltered direct-child search returns children in canonical spawn-call order; filtered results use relevance first and that order as their deterministic tie-breaker. Observation is passive and supports exact status lookup plus bounded composable search over authorized Agent scopes. It returns identity, structural relationship, and live Run state without exposing a Pi session or Run handle; search never prepares a dormant Runtime.

Ordinary child transcripts share the Owner-derived Workflow directory regardless of effective Run cwd. A fresh host validates that directory to recover verified dormant Agents and authority; see [Cold host recovery](cold-host-recovery.md).
