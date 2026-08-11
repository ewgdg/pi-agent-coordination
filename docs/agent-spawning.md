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
    thinking: "high",
    tools: ["read", "grep"],
    projectContext: "Reproduce the failure before proposing changes.",
    projectContextMode: "append",
  },
})
```

`request` is required. `template`, `label`, and `description` are optional. `config` may override model, thinking level, working directory, ordinary tools, skills, and Project Context. Arrays replace inherited tool and skill selections, including an empty array. Child extension selection is `inherit` or `none`; arbitrary per-child extension paths are not accepted.

The label resolves from the explicit label, selected template name, then `agent`. A description comes only from the explicit spawn input. Display metadata is trimmed, preserves Unicode, rejects line breaks and control characters, and is limited to 64 Unicode code points for labels and 240 for descriptions.

The authenticated calling Agent becomes the immutable Direct Spawner. Agent identity, Workflow membership, authority, role-required tools, and Creation Request delivery mode are not caller-supplied fields.

The child receives a fresh durable Pi session. Its immutable baseline captures the caller's admitted Runtime snapshot: working directory, model, thinking level, ordinary tools, selected skill names, canonical file-backed extensions, and trust. The caller's committed blueprint binds selected child skill names to their exact source paths. It does not inherit the caller's transcript, branch, model context, assembled prompt, editor state, or queued input.

Template, effective resources, immutable spawn overrides, role tools, trust, and Project Context resolve once before Agent Identity. The result is committed as one Runtime Blueprint. Successor and cold-recovered Runtimes reuse that blueprint; they do not re-read changed Templates or rediscover a different inherited resource set.

Only canonical file-backed inherited extensions cross the process boundary. `extensions: "none"` excludes them. Pi-owned built-ins are reconstructed by the fresh Pi CLI. Arbitrary injected, anonymous, and named inline factories are process-local composition details and are not child inheritance inputs.

## Agent Templates

Templates are discovered recursively from these roots, lowest to highest precedence:

1. `<coordination-package>/agents/`
2. `<Pi-agent-directory>/agents/`
3. `~/.agents/agents/`
4. `<baseline-working-directory>/.agents/agents/` when that project is trusted

Discovery follows file and directory symlinks with canonical-path cycle prevention. A higher-precedence file replaces the whole lower definition. Same-precedence duplicates make that name unavailable, and a malformed named higher-precedence definition blocks lower fallback.

A Template is UTF-8 Markdown with required leading YAML frontmatter:

```markdown
---
name: integration-researcher
model: anthropic/claude-sonnet-4-5
thinking: high
tools: read, grep
skills:
  - research
extensions: inherit
project-context: append
---
Use primary sources and record exact reproduction evidence.
```

`name` is required lowercase kebab-case. The only other frontmatter fields are `model`, `thinking`, `tools`, `skills`, `extensions`, and `project-context`. The Markdown body is Project Context. Templates cannot define display metadata, working directory, the Creation Request, identity, authority, or lifecycle behavior. The reserved name `moderator` cannot be selected by ordinary `agent_spawn`.

The per-spawn `config.cwd` resolves against the immutable baseline working directory and determines the effective Run cwd. Template discovery remains anchored to the baseline. Pi applies its project-trust decisions to that effective cwd, freshly discovers permitted ordinary `AGENTS.md` context and cwd-scoped resources there, then applies Template and spawn Project Context with append/replace behavior. An untrusted project cannot contribute selected resources.

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
