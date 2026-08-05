# Rediscover Agents, authority, and residual Requests after host loss

## Goal

Implement GitHub issue #44 so a resumed Workflow Owner reconstructs only the durable ordinary-Agent roster, structural authority, evidence locations, and exact residual Request retention that complete Pi transcripts prove.

## Intention

Treat cold admission as a one-shot evidence projection, not runtime restoration. Validate the already-active Owner first, strictly snapshot every candidate transcript in the Owner-derived Workflow directory, verify the complete ordinary authority graph, and publish a fresh disposable index only after the graph is closed and conflict-free. Recovered children remain dormant until ordinary input starts a successor Run. Every newly started exact Run derives its own Request Retention Reasons immediately before Pi session construction; no scheduling or work is replayed.

## Scope & Constraints

- Implement issue #44 only; do not add Moderator discovery, Workflow forking, Incidents, or moderation behavior from later issues.
- Keep the resumed Owner in its native Pi session file. Store ordinary child sessions in the existing deterministic Workflow directory below the Owner session directory, independent of effective Run cwd.
- Admit a child only from one complete current-version LF-terminated JSONL transcript whose native header, one current Identity, canonical spawn pointer/input, Workflow, Direct Spawner path, and unique source all verify.
- Preserve physical canonical spawn-call order for direct children. Use Pi's user/assistant activity recency semantics only for dormant `/agents` ordering.
- Quarantine conflicting or unverified candidates and every dependent descendant, while retaining independently verified subtrees. Publish one bounded volatile warning and never mutate candidate transcripts.
- Return `evidence_unavailable` when an operation names identifiable quarantined proof; retain `unknown_identity` for identities with no candidate evidence.
- Reconstruct only exact outgoing `awaiting_answer` and incoming `answer_owed` Run Retention Reasons. Do not restore delivery queues, invocations, Runs, scheduling, Incidents, Handling Keys, global obligation state, model turns, or Messages.
- TDD seams are fixed by issue #44: fresh bootstrap/reopen through the real extension host, role-bound observation/messaging, and strict transcript/authority validation. Avoid private-helper tests except for strict evidence validation that cannot be observed precisely through the host.
- Preserve the clean user branch beginning at `a506160`; do not rewrite the three commits already ahead of `origin/main`.

## Work Plan

1. Add reopen-harness support and a failing end-to-end test for deterministic transcript placement, nested cold recovery, physical child ordering, passive dormant presentation, and fresh re-admission.
2. Implement strict one-shot candidate snapshots, exact child Identity/source validation, graph conflict/cycle/dependency quarantine, disposable indexes, and lazy recovered Agent records.
3. Add failing quarantine tests for duplicate spawn claims, dependent propagation, bounded warning, `evidence_unavailable`, and byte-for-byte transcript non-mutation; implement the smallest complete behavior.
4. Add failing residual Request reopen tests covering ordinary and Creation Requests, Answer/Cancellation boundaries, branches, compaction, and repeat host loss. Initialize exact relationships before each Run start and for the already-bound resumed Owner.
5. Split `/agents` into Live and Dormant roster ordering without starting dormant Runs; keep live creation hierarchy and compute dormant order with Pi-compatible activity recency.
6. Document the cold-recovery contract under `docs/`, including what returns and what is deliberately lost.
7. Run focused tests and typechecking throughout, then full tests, build, package dry run, production audit, and diff checks once.
8. Run independent Standards and Spec reviews against `a506160`, repair findings, revalidate, move this plan to `plans/done/`, and commit semantically with `Closes #44` as the first body line.

## Validation

- Focused cold-host reopen and strict evidence tests.
- Focused Agent Request, spawn, message, bootstrap, and Owner workflow suites.
- `npm run typecheck` throughout implementation.
- Final `npm test`, `npm run typecheck`, `npm run build`, `npm pack --dry-run`, `npm audit --omit=dev`, and `git diff --check`.
- Two-axis review against `a506160`. Standards sources: `AGENTS.md`, `CONTEXT.md`, relevant completed plans/docs, and the smell baseline. Spec source: issue #44 and the cold-host decisions in parent issue #34.

## Progress

- [x] Inspect issue #44, parent cold-host decisions, current bootstrap/spawn/Request/presentation architecture, Pi 0.83.0 session behavior, and existing public seams.
- [x] Fix the implementation boundaries and public TDD seams.
- [x] Implement strict cold admission and authority indexes.
- [x] Implement lazy dormant records and Live/Dormant presentation.
- [x] Implement per-Run residual Request initialization.
- [x] Document and complete validation.
- [x] Independently review, repair, revalidate, and commit.

## Surprises & Discoveries

- `SessionManager.list(cwd, customDirectory)` filters custom directories by header cwd, so it omits valid Agents whose immutable baseline cwd differs from the Owner. Candidate discovery must enumerate the Workflow directory without that filter.
- Pi's discovery/parser skips malformed lines and accepts an unterminated tail, while opening older session versions may rewrite them. Admission therefore needs a strict raw completeness/current-version check before `SessionManager.open` can be used without violating no-mutation.
- Existing Owner validation rejects all later `agent-coordination.*` evidence after the Owner Identity. A valid resumed Owner necessarily may contain such evidence; the matching Identity is the current-scope cutoff, not a prohibition on later coordination.
- Request evidence already scans the complete physical current scope, so sibling branches and pre-compaction facts are available. The missing capability is exact relationship projection at every Run start.

## Decisions

- Reuse the existing Owner-derived Workflow directory and make its contract explicit instead of introducing a second registry path.
- Keep recovered child services lazy. A dormant record needs Identity, transcript manager, authority, and a restart closure; Pi services and effective configuration are created only for an actual successor Run.
- Make a single recovered authority result the source for Agent, transcript, source-pointer, child-order, and quarantined-identity indexes. Runtime maps are populated only from that verified result.
- Initialize Request Retention Reasons through the concrete host's pre-start boundary so every start path receives the same transcript-derived projection. Initialize the already-bound resumed Owner during awaited admission.

## Outcomes

- Cold admission now reconstructs a fresh verified ordinary-Agent authority tree and disposable evidence indexes from the Owner-derived Workflow directory without mutating candidate transcripts.
- Recovered Agents remain passive dormant records until ordinary work starts a successor Run, while `/agents` separates live hierarchy from dormant Pi-recency order.
- Each Run reconstructs only its exact transcript-proven Request Retention Reasons, including local relationships whose peer proof is quarantined; peer-dependent operations return `evidence_unavailable`.
- Independent Standards review found no hard violations after repair. Independent Spec review found no remaining issue #44 gaps.
- Final validation passed 119 tests, typecheck, build, package dry run, production audit with zero vulnerabilities, and diff hygiene.
