# Native child project-context inheritance

## Goal

Replace the process Runtime's aggregated `context.md` project-context snapshot with two independent launch controls:

- `inheritProjectContext`: whether the child Pi process uses native `AGENTS.md`/`CLAUDE.md` discovery.
- `systemPromptMode`: whether the explicit child/template system prompt is passed with `--append-system-prompt` or `--system-prompt`.

Make inherited-context children compatible with context-transforming extensions by leaving native context discovery enabled, while retaining explicit isolation for replacement children.

## Intention

Model the child launch after `pi-subagents`: native project context and explicit child system prompt are separate channels. Remove the generated aggregate that currently merges ordinary context files with configured prompt bodies, disables native discovery for every child, and obscures the extension seam.

## Scope & Constraints

- No backward-compatibility or legacy aliases. Replace the old `projectContextMode`/aggregate semantics with the new model.
- Keep process isolation, trust resolution, skills, extension selection, and coordination behavior unchanged.
- Keep a private temporary file only when an explicit child system-prompt body must be supplied to Pi's file-backed CLI flags.
- `systemPromptMode: "replace"` controls Pi's base system prompt only. Full project-context isolation requires `inheritProjectContext: false`.
- Accept Pi's native ordering: explicit `--append-system-prompt`/`--system-prompt` content is assembled before native project context when project context is inherited.
- Update durable protocol/configuration/docs/tests together; do not leave the old aggregate artifact contract exposed.

## Work Plan

1. Add tests first for the new launch contract and configuration semantics.
2. Replace template/spawn configuration fields with explicit system-prompt mode/body and project-context inheritance.
3. Change child preparation to stop loading/serializing ordinary context files; retain resource loading needed for skills and trust.
4. Replace aggregate context artifact materialization with an explicit system-prompt artifact only.
5. Change Pi CLI launch construction to conditionally emit `--no-context-files` and independently select `--system-prompt` vs `--append-system-prompt`.
6. Update child runtime snapshot/bridge verification to report and validate the explicit prompt channel without treating native context as an artifact.
7. Update all protocol schemas, tool receipts, template guides, docs, and tests.
8. Remove obsolete aggregate context module/tests and run focused typecheck/test suites.

## Intended mapping

- Existing template/spawn append behavior becomes `systemPromptMode: "append"` plus `inheritProjectContext: true`.
- Existing replacement/isolation behavior becomes `systemPromptMode: "replace"` plus `inheritProjectContext: false`.
- A replacement system prompt with `inheritProjectContext: true` intentionally retains native project context.

## Validation

- Unit tests prove inherited launch omits `--no-context-files`, replacement launch includes it even for an empty prompt, and prompt mode chooses the correct CLI flag.
- Preparation tests prove ordinary context is not copied into a child artifact and explicit prompt configuration is preserved.
- Process tests prove inherited children see native context, isolated children do not, and prompt snapshots/handshake agree for append and replace modes.
- Windows tests prove explicit prompt artifacts remain ordinary temp files and named-pipe control is unaffected.
- Run focused fast/process tests plus `npm run typecheck`; avoid unrelated full-suite work until the focused blast radius is green.

## Progress

- [x] Confirmed design against `nicobailon/pi-subagents` 0.51.0.
- [x] Add/update tests.
- [x] Implement configuration and launch changes.
- [x] Update bridge/snapshots and remove aggregate artifact.
- [x] Update docs and complete validation.

## Surprises & Discoveries

- Pi's `--append-system-prompt` content is assembled before native project context, so adopting native inheritance intentionally changes configured-body ordering from the old aggregate `[native, configured]` order to Pi's `[explicit prompt, native]` order.
- The current child artifact is not only explicit configured context: append mode copies ordinary context files too, which is the source of duplication and the context-expander incompatibility.

## Decisions

- Use native project context when inherited; do not reconstruct it into a temporary aggregate.
- Keep `systemPromptMode` independent from `inheritProjectContext`.
- Treat `systemPromptMode: "replace"` plus `inheritProjectContext: true` as base-prompt replacement with native project context retained, matching Pi behavior and `pi-subagents`.

## Outcomes & Retrospective

Implemented the split launch contract. Templates and spawn overrides now use `systemPrompt`, `systemPromptMode`, and `inheritProjectContext`; native context discovery is disabled only for explicit isolation. Ordinary context files are no longer loaded during parent preparation or serialized into an aggregate artifact. Explicit prompts use a private `system-prompt.md` artifact and are independently passed with `--system-prompt` or `--append-system-prompt`. Runtime snapshots and the Control protocol now report the explicit prompt channel and inheritance decision; protocol version advanced to 2. The old `context.md` aggregate module and tests were removed. `npm run typecheck` and `npm test` pass. Validation also fixed a pre-existing test setup race that wrote a file concurrently with creation of its parent directory.
