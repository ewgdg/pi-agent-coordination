# Template creation presets

## Goal and intention
Templates supply creation-time rules owned by the resulting Agent, not a name dependency on later Runtime starts. Discovery and model-safe catalogue are prefetched per spawning Runtime load and reused until its existing reload lifecycle.

## Scope and constraints
Ordinary and Moderator atomic bootstrap, dormant ancestry, cold restoration, existing Owner/child reload hooks, maintained docs. Preserve candidate lists, explicit inherit and omitted inheritance; continue resolving current parent and Pi resources. No migration, fallback, richer delivery errors, commit or PR. Work only on fix/template-creation-presets in this worktree.

## Decisions
- Capture only template configuration rules, omitting discovery name/source/useWhen. Null means no template, including absent reserved Moderator template.
- Store rules in the same bootstrap append as identity (conceptually independent of authority). Explicit overrides remain in canonical Spawn input. Parent approved this representation and test seams.
- In-memory discovery belongs to each spawning Agent's load, not a process-wide filesystem cache. Selection and guidance use the same discovery.
- Pi README, complete extensions and session-format docs, reload-runtime example read. Latest upstream extensions doc matches installed copy. Reload emits shutdown then session_start/resources_discover reload; this project retains the coordinator via its global session registry, so its factory must explicitly refresh the reloaded Agent's discovery.

## Work plan
1. Regression at public factory preparation/snapshot seam; observe red, implement captured rules and load catalogue.
2. Atomic durable capture, cold validation/restoration, ordinary/Moderator regressions.
3. Existing reload-hook integration, inheritance/candidate availability tests.
4. Update maintained docs, targeted tests and typecheck; independent review is requester's responsibility.

## Validation
Public factory preparation and snapshots; canonical spawn and cold discovery/restoration; existing reload hooks. Test failures must be observed before implementation. No full suite; process tests only targeted.

## Progress
- Architecture and reload documentation inspected; representation/test seams approved.

- Observed red before fixes: dormant parent rules changed on edit; prefetched name vanished after rename; Moderator restart used replacement prompt; bootstrap lacked captured preset.
- Implemented atomic captured rules for ordinary and Moderator creation and strict cold bootstrap validation. Runtime preparation uses those rules and canonical overrides with current parent/resources; ancestry does not reload template discovery.
- Implemented per-spawning-Agent in-memory discovery plus safe catalogue, refreshed through existing lifecycle. Owner initialization now prefetches centrally, including direct coordinator admission.
- Verified inherited model/thinking/cwd/tools/skills/extensions remain dynamic with both omitted fields and explicit inherit; ordered template candidates remain captured without availability filtering.
- Updated maintained docs and bootstrap fixtures. Expanded cold Moderator test waits for committed bootstrap rather than parked Owner settlement.
- Final targeted validation: 85 distinct tests passed; typecheck and diff check passed. Six unrelated failures were reproduced from an unmodified HEAD archive (four reconciliation fixture failures and two powershell tool-list mismatches).
- No full suite, Windows process execution, commit, PR, migration, or compatibility fallback.

## Outcomes and remaining limitations
The creation policy is durable across dormant successor Runs and cold host restoration, including a missing original template name. File edits during a load cannot alter that spawning Agent's selections; reload affects future creations only. Current model availability and inherited/project resources can still fail independently.

The strict bootstrap contract requires captured presets; existing transcripts without that field need a separately authorized transition. No transition behavior is included.

Exact commands, pass counts, and baseline-failure evidence are stored under the agent artifact output `pi-agent-coordination/2026-09-07/template-creation-presets/validation.md`. The requester owns independent review and publishing.
