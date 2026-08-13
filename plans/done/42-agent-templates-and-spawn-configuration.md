# Resolve Agent Templates and immutable spawn configuration

## Goal

Implement GitHub issue #42 so an ordinary Agent can select a strict named Agent Template and immutable spawn-owned runtime overrides, while each Agent Run deterministically resolves current template content over the stored parent-derived baseline and keeps Pi's native cwd/resource/context behavior authoritative.

## Intention

Keep the irreversible protocol boundary small: the canonical `agent_spawn` call stores the selected template name and overrides, while child Identity stores only resolved display metadata and the parent-derived runtime baseline. Validate the complete first-Run configuration before Identity commit, reuse that verified bundle for Run 1, and rebuild a fresh bundle from the same canonical inputs for every successor Run.

## Scope & Constraints

- Implement issue #42 and the accepted Agent Spawn Configuration/Template decisions in parent issue #34, refined by issues #22, #26, #28, and #32.
- Template roots, low to high: coordination package `agents/`, Pi user `<agentDir>/agents/`, user `~/.agents/agents/`, and trusted `<baseline cwd>/.agents/agents/`.
- Follow file and directory symlinks, prevent canonical-directory cycles, and deduplicate canonical files within each root without moving their discovery precedence.
- Parse UTF-8 Markdown with required leading strict YAML frontmatter. Allow only `name`, `model`, `thinking`, `tools`, `skills`, `extensions`, and `project-context`; the Markdown body is Project Context. Reject aliases, anchors, merge keys, custom tags, implicit type coercion, duplicate/unknown fields, and invalid values.
- Whole definitions replace across precedence. Same-level duplicate names are unavailable. A malformed higher-level file with a valid name blocks lower fallback for that name.
- Agent Spawn accepts required `request`; optional `template`, `label`, `description`; and optional `config` overrides for model, thinking, cwd, tools, skills, extensions, Project Context body, and append/replace mode.
- Explicit label/description normalization trims surrounding whitespace, rejects empty values, line breaks and control characters, preserves other Unicode, and enforces 64/240 Unicode code-point limits. Ordinary labels resolve explicit label, selected template name, then `agent`; description is explicit-only.
- Effective cwd is the immutable spawn override resolved against baseline cwd, otherwise baseline cwd. Template discovery never follows effective cwd.
- Resolve Run configuration in order: stored baseline, current whole template, immutable spawn overrides, fixed ordinary-role tools/wiring.
- Pi freshly loads context/resources for effective cwd. Apply template Project Context then spawn Project Context with append/replace semantics without parent conversation/prompt copying.
- `pending` and confirmed partial receipts expose verified effective runtime configuration; `not_created` and unresolved indeterminate boundaries must not invent it. Expanded native rendering exposes full verified configuration.
- Preserve issue #36–#41 protocol behavior and avoid legacy compatibility paths.
- TDD seams are pre-agreed by #42: pure parsing/discovery/configuration APIs and real hosted `WorkflowCoordinator`/`agent_spawn` session behavior.

## Work Plan

1. Add a strict template parser/discoverer and pure runtime configuration resolver, one failing behavior test and minimal implementation per vertical slice.
2. Expand Agent Spawn protocol input validation and tool schema; add shared label normalization and resolve metadata before Identity.
3. Refactor child session creation into preflighted/fresh Run bundles, update the live Agent record's current services, and apply effective cwd/resources/Project Context.
4. Add effective configuration receipts and native spawn rendering; update Agent spawning documentation for the final interface and template locations.
5. Run focused tests and typechecking throughout, then build/full tests/diff checks. Run Standards and Spec reviews against the pre-work commit, address findings, and commit with a semantic issue-closing message.

## Validation

- Focused pure template/configuration test file.
- Focused real-session Agent Spawn test file.
- `npm run typecheck` during implementation.
- `npm run build`.
- `npm test` once at the end after focused suites pass.
- `git diff --check`.
- Two-axis code review against `4cb9623` using issue #42 plus the accepted parent/refinement text as the Spec source.

## Progress

- [x] Read repository instructions, domain glossary, completed spawn/run plans, issue #42, and accepted parent/refinement decisions.
- [x] Confirm public TDD seams from issue #42.
- [x] Implement strict template parsing/discovery/resolution.
- [x] Implement expanded immutable spawn configuration and metadata.
- [x] Implement per-Run fresh runtime creation and Project Context behavior.
- [x] Implement receipts/rendering/docs.
- [x] Validate, review, fix findings, and commit.

## Surprises & Discoveries

- The current factory validates and creates services once, then reuses them for every Run. Issue #42 requires services and selected template content to be rebuilt per Run while retaining only the parent-derived baseline and canonical spawn input.
- Pi 0.83.0 already separates `createAgentSessionServices()` from `createAgentSessionFromServices()`, which is the correct seam for resolving cwd-bound resources before session construction.
- Pi's native prompt-template parser and resource discovery are intentionally unsuitable for Agent Templates: they are permissive, use different identity/precedence rules, and do not prevent canonical symlink cycles.
- The Pi transcript header cwd remains the baseline session location; current `AgentSessionServices.cwd` is the authoritative effective Run cwd for descendant inheritance and native selection.
- Pi's effective-cwd trust path must resolve pre-trust extension decisions, stored decisions, and `defaultProjectTrust` before cwd-scoped resources load; constructing `SettingsManager` with its default trust value bypasses that gate.

## Decisions

- Reuse the preflighted first-Run bundle after Identity commit so the committed child starts with exactly the configuration that passed validation; discard it after Run 1 and resolve every successor from current files.
- Keep selected template and spawn overrides out of Identity, as required. The live restart closure may retain the already validated canonical input because cold-host rediscovery is outside this issue.
- Add `yaml` as a direct runtime dependency rather than relying on Pi's transitive installation or implementing YAML.
- Keep Agent Run trust resolution non-interactive. Pre-trust extensions, stored decisions, and global trust policy remain authoritative; an unresolved `ask` decision follows Pi's no-UI behavior and keeps the project untrusted.

## Outcomes & Retrospective

Issue #42 is implemented as one issue-closing commit. Agent Spawn now accepts strict Template selection, display metadata, and immutable runtime overrides; Identity retains only normalized metadata, the canonical source, and the parent-derived baseline. Template parsing, discovery, and selection are separate focused modules, and every successor Run rebuilds cwd-bound services from the current Template without stale fallback.

Real-session coverage proves baseline/effective-cwd separation, Pi project trust, Project Context composition, fixed tools, resource validation, Template edits between Runs, malformed-template blocking and repair, and context isolation. The final gate passed 100 tests, typecheck, build, package dry-run, audit, and committed-diff whitespace validation. Independent Standards and Spec reviews against `4cb9623` both passed with no remaining findings after corrections.
