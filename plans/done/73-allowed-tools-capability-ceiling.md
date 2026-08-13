# Allowed tools capability ceiling

## Goal

Model child tool configuration as an allowlist rather than an exact active-tool list, so inherited extensions may activate, deactivate, and reorder tools without making child Runtime admission fail.

## Intention

Keep configuration responsible only for the maximum tool capability available to Pi. Treat the child Runtime's active tools as live extension-controlled state.

## Scope & Constraints

- Replace Agent Spawn `config.tools` with `config.allowed_tools`; do not retain a compatibility alias.
- Replace Agent Template `tools` with `allowed-tools`.
- Name the resolved configuration field `allowedTools`.
- Preserve actual active tools as `tools` in live Runtime snapshots.
- Inherit the configured allowlist through child Runtime ancestry, not a child extension's momentary active-tool selection.
- Always add the exact role-required coordination tools to the allowlist.
- Pass the allowlist through Pi's existing `--tools` option.
- Admit startup when active tools are any ordered subset of the allowlist. Reject active tools outside it.

## Test Seams

1. Agent Spawn validation and model-visible tool schema.
2. Agent Template parsing, catalogue projection, and configuration resolution.
3. Child CLI launch arguments.
4. Real process Runtime admission through `PiChildProcessRuntime.start`.
5. Hosted Runtime snapshot inheritance.

## Work Plan

1. Add failing tests for the renamed public configuration fields.
2. Rename the durable/configured tool selection through templates, preparation, receipts, schemas, and docs.
3. Add failing process Runtime tests for reordered/subset and out-of-allowlist active tools.
4. Change startup snapshot validation from ordered equality to capability containment.
5. Carry the configured allowlist separately from live active tools in hosted Runtime snapshots and descendant preparation.
6. Run targeted tests, typecheck, then the full suite.

## Validation

- Targeted tests complete in under five seconds where possible.
- `npm run typecheck`
- `npm test` once targeted validation is green.

## Progress

- [x] Diagnosis proved extension-controlled `apply_patch`/`web_run` reordering causes the current order-sensitive failure.
- [x] Fresh `feat/allowed-tools` worktree created.
- [x] Public configuration rename complete.
- [x] Capability-containment Runtime validation complete.
- [x] Documentation and targeted validation complete; the complete suite remains blocked by pre-existing long-running PTY failures.

## Decisions

- Tool order is live Runtime state, not configured identity.
- An allowed tool need not be registered or active; allowlist membership is not an availability assertion.
- Coordination tools remain role-required capabilities added during Runtime preparation.

## Surprises & Discoveries

- Pi already implements `--tools` as both an allowed-tool ceiling and initial active selection. Extensions may subsequently choose any active subset and order within that ceiling.
- Unknown allowed tools are legitimate capabilities: they may remain unregistered without invalidating startup.
- The complete serial suite has unrelated pre-existing Agent-selector/PTY failures and hangs; the changed seams pass 107 targeted tests.

## Outcomes & Retrospective

Agent Spawn now exposes `config.allowed_tools`, Agent Templates expose `allowed-tools`, and resolved receipts expose `allowedTools`. Live Runtime snapshots still expose actual active `tools` while also retaining `allowedTools` for descendant inheritance. Process startup validates active-tool containment and tool-mode alignment rather than exact configured order.
