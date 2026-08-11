# Restore dynamic Agent Runtime configuration

## Goal

Preserve process-isolated non-Owner Runtimes without persisting resolved Runtime configuration or inherited Runtime snapshots. Durable Agent state stores only identity facts and canonical creation inputs. Every new Runtime preparation recursively resolves current ancestry, Templates, resources, trust, Project Context, and effective launch arguments. A retained Runtime keeps its prepared configuration across its exact Runs.

## Scope and constraints

- Remove durable resolved Runtime evidence and its protocol/module surface.
- Store ordinary display metadata and the canonical Agent Spawn pointer in child Identity; keep Template selection and explicit `config` only in the canonical tool call.
- Store only fixed display metadata, Workflow relationship, and trigger evidence in Moderator Input.
- Resolve ordinary and Moderator launch specifications immediately before each new Runtime.
- Use an admitted live parent Runtime when present; otherwise recursively resolve a dormant parent's canonical creation chain without starting ancestors.
- Reuse the first ephemeral preparation only for the first Runtime whose Identity/session header it created.
- Cold recovery verifies Identity and canonical creation sources, then resolves current configuration only when a Runtime is prepared.
- Keep one transcript writer: Owner materializes role bootstrap evidence, drops staging ownership, then the child process owns writes.
- Keep resolved effective configuration in volatile receipts, Runtime snapshots, and launch arguments only.
- Preserve process isolation, PTY, Control, `/agents`, lifecycle, scheduling, and Herdr behavior.
- Document at the Runtime preparation seam that dynamic resolution is deliberate product semantics and must not be replaced by persisted resolved configuration unless explicitly requested.
- Windows named-pipe work remains paused until this correction is complete.

## Behavioral seams

1. A newly materialized ordinary or Moderator transcript contains role bootstrap evidence but no resolved Runtime configuration record.
2. The first process launch uses the effective configuration resolved for that Runtime preparation.
3. A later Runtime preparation observes changed ancestry, Template, resources, trust, and Project Context while preserving canonical explicit spawn overrides.
4. A retained Runtime does not change configuration between exact Runs.
5. Cold recovery reconstructs canonical creation inputs and dynamically prepares its next Runtime.
6. Nested spawning uses the admitted parent Runtime directly, while a dormant parent is dynamically reconstructed from its verified creation chain.

## Work plan

1. Add failing materialization and successor tests for dynamic preparation.
2. Replace the durable resolved Runtime record with an ephemeral launch specification.
3. Refactor the process child factory to retain canonical creation input only in volatile host records and resolve on each `startSession`.
4. Remove resolved configuration commitment from ordinary and Moderator creation and Message Delivery handling.
5. Refactor cold recovery to return canonical spawn input rather than resolved configuration.
6. Remove inherited snapshots from Owner, child, and Moderator Identity shapes.
7. Update documentation to state canonical creation facts and volatile Runtime preparation directly.
8. Run focused spawn, successor, cold-recovery, nested-parent, Moderator, process-runtime, transcript, and conformance tests.

## Validation

- Focused tests for transcript materialization, spawn, process factory, dynamic Template/resource reload, cold recovery, nested spawn, Moderator recovery, and process launch.
- `npm run typecheck`
- `npm test`
- `npm run test:conformance`
- `npm pack --dry-run`
- `npm audit --omit=dev`
- `git diff --check`
- Real Herdr Owner → child → Owner reproduction.

## Progress

- [x] Confirmed the resolved Runtime record changed configuration lifecycle semantics outside process isolation.
- [x] Decided that omitted child fields dynamically follow current parent resolution; no inherited snapshot is durable.
- [x] Removed durable resolved Runtime evidence and inherited Identity configuration.
- [x] Restored dynamic ordinary, Moderator, successor, dormant-parent, and cold-recovered Runtime preparation.
- [x] Added the required product-decision source comment.
- [x] Updated domain documentation and completed focused, full regression, conformance, package, audit, diff, and real Herdr validation.

## Decisions

A fully resolved process launch specification is volatile Runtime state, not durable Agent configuration. Serialization across the process boundary does not justify transcript persistence or successor reuse.

An ordinary Agent's durable Runtime inputs are exactly the selected Template and explicit `config` in its canonical Agent Spawn call. Omitted values are resolved from the current parent configuration whenever a new Runtime is prepared. A live retained Runtime does not mutate; dynamic changes apply only to a new Runtime.
