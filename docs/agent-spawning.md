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
    tools: ["read", "grep"],
    projectContext: "Reproduce the failure before proposing changes.",
    projectContextMode: "append",
  },
})
```

`request` is required. `template`, `label`, and `description` are optional. `config` may override the model/thinking pair, working directory, ordinary tools, skills, and Project Context. A `config.model` object requires both `id` and `thinking`; either may be `inherit` to use that value from the current parent Runtime. `id: inherit` with `thinking: inherit` is valid. Providing `config.model` bypasses Template model candidates entirely. Arrays replace inherited tool and skill selections, including an empty array. Child extension selection is `inherit` or `none`; arbitrary per-child extension paths are not accepted.

The label resolves from the explicit label, selected template name, then `agent`. A description comes only from the explicit spawn input. Display metadata is trimmed, preserves Unicode, rejects line breaks and control characters, and is limited to 64 Unicode code points for labels and 240 for descriptions.

The authenticated calling Agent becomes the immutable Direct Spawner. Agent identity, Workflow membership, authority, role-required tools, and Creation Request delivery mode are not caller-supplied fields.

The child receives a fresh durable Pi session, but no resolved parent or child Runtime configuration is copied into its Identity or transcript. Its durable creation facts are display metadata, Workflow and Direct Spawner relationships, and a pointer to the canonical `agent_spawn` call. That call remains the sole source of the selected Template and explicit `config`. The child does not inherit the caller's transcript, branch, model context, assembled prompt, editor state, or queued input.

Immediately before each new Runtime, the host resolves the current parent configuration. A live parent contributes its admitted Runtime; a dormant parent is resolved recursively from the current Owner, current Templates, and canonical ancestor spawn inputs without starting those ancestors. The host then applies the child's current selected Template, explicit spawn configuration, role tools, current resources, trust, and Project Context. The resulting launch specification is volatile and belongs only to that Runtime. The first preparation may be reused for the first process whose session header it created; successor and cold-recovered Runtimes always prepare again. A retained Runtime keeps its resolved configuration across its exact Runs.

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
selection-guide: Use for integration work requiring external documentation or source verification.
models:
  - id: anthropic/claude-sonnet-4-5
    thinking: high
  - id: deepseek/deepseek-v4-flash
    thinking: medium
tools: read, grep
skills:
  - research
extensions: inherit
project-context: append
---
Use primary sources and record exact reproduction evidence.
```

`name` is required lowercase kebab-case. Optional `selection-guide` is nonblank text that tells a spawning Agent when to select the Template. Optional `models` is a nonempty ordered sequence of `id` and `thinking` pairs. The first model available in Pi's current model registry supplies both values, and preparation fails when none are available. Without `models`, the parent model and thinking pair is inherited. The other frontmatter fields are `tools`, `skills`, `extensions`, and `project-context`. The Markdown body is Project Context. Templates cannot define display metadata, working directory, the Creation Request, identity, authority, or lifecycle behavior. The reserved name `moderator` cannot be selected by ordinary `agent_spawn`.

Before each model turn, an Agent that can spawn receives its current model/thinking pair and the currently valid Template catalogue. Each entry exposes its name, selection guide, configured frontmatter values, and only model candidates present in Pi's current model registry. A Template whose configured candidates are all unavailable is omitted. This lets the Agent select a Template or deliberately override values through `agent_spawn.config`. Invalid and ambiguous Templates, Template source paths, discovery diagnostics, and Markdown Project Context bodies are not exposed.

For every new Runtime, Template discovery is anchored to the current parent Runtime cwd. The per-spawn `config.cwd` resolves against that cwd and determines the prepared Runtime cwd. Pi applies its current project-trust decision there, freshly discovers permitted ordinary `AGENTS.md` context and cwd-scoped resources, then applies Template and spawn Project Context with append/replace behavior. An untrusted project cannot contribute selected resources. Changes to ancestor Templates, resources, trust, or cwd can therefore affect a later descendant Runtime; they never mutate an already retained Runtime.

## Commitment and delivery

The committed native `agent_spawn` tool call is the Creation Request source. The child Identity append commits the child and Request together. After that append, startup or scheduling failure never removes either fact.

The child starts a fresh Pi CLI/TUI process and receives the Request through the same fixed Deferred lane used by ordinary [Agent messaging](agent-messaging.md). A successful spawn receipt reports volatile admission; it does not claim that Delivery committed, the model processed the Request, or an Answer exists.

Confirmed Delivery admission failure releases the new child Run to dormant while preserving the committed child and Creation Request. Once Delivery commits, the Run remains retained while the child owes the corresponding Answer.

After child Identity commit, the Creation Request uses the ordinary [Request protocol](agent-messaging.md): the Spawner can poll, retry, retrieve its Answer, or cancel; the child Answers through `agent_message`. The Answer fulfills one Request obligation and does not represent child completion or lifecycle state.

## Receipts

- `pending` — the child and Request exist, the first Run started, and Delivery was admitted.
- `created_unscheduled` — the child and Request exist, but confirmed Run startup or Delivery admission failed.
- `not_created` — validation failed before child Identity committed.
- `indeterminate` — confirmation was lost at a boundary where effects may exist.

Confirmed and partial receipts include the effective runtime configuration only after it has resolved and passed resource validation. Collapsed native rendering shows the disposition, Agent identity, model, and thinking level. Expanded rendering shows the complete structured receipt and effective configuration.

Repeating `agent_spawn` creates a sibling. Direct children appear to their Spawner in canonical spawn-call order. Observation is passive and returns bounded identity and live Run state without exposing a Pi session or Run handle.

Ordinary child transcripts share the Owner-derived Workflow directory regardless of effective Run cwd. A fresh host validates that directory to recover verified dormant Agents and authority; see [Cold host recovery](cold-host-recovery.md).
