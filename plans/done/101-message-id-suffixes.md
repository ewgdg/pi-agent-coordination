# Message and Request suffix references (#101)

## Objective
Retain Pi-session Agent IDs and deterministic hash Message IDs. Extend existing Agent suffix targeting to Message poll/retry and Request cancellation inputs. No allocator, database, alias registry, cross-Workflow routing, or scheduling changes.

## Design
Resolve exact IDs first and otherwise unique suffixes among the caller's earlier authored Message sources (including Spawn Creation Requests). For suffix expansion, bound the lookup by the referring committed tool call, so later Messages cannot change replay or retry resolution. Durable receipts and cancellation relationships contain full canonical IDs. Rebuild resolution from retained transcript evidence; do not persist a new registry. Unavailable, ambiguous, and wrong-participant references fail without delivery.

## Steps
- Restore canonical identity implementation from PR base cb47e58.
- Add failing public coordinator tests for suffix poll/retry/cancel, ambiguity, and stable replay.
- Implement shared source-bound resolution and canonical cancellation projection.
- Shorten rendered Message IDs with full IDs available on expansion; retain complete structured receipts.
- Independent Standards and Spec review; focused tests, typecheck, packaging, audit, diff checks.
- Update #101 and PR #103 to final scope; make a new semantic commit and push.

## Progress
Restored the base identity design; removed SQLite allocation and session-decoupling changes. Prior implementation remains in git history for recovery, not in the resulting source tree.

- Implemented suffix poll/retry/cancel at the coordinator boundary. Full hashes remain literal references with existing evidence and participant checks; suffixes resolve against earlier authored sources only.
- Cancellation projections normalize references to full IDs. A source-keyed retained projection caches candidate hashes; authored-fact reconstruction skips poll/retry before resolution.
- Added deterministic collision/native JSONL reopen coverage, real coordinator reopen cancellation coverage, and collapsed/expanded Message rendering checks.
- Independent Standards and Spec reviews are clear after fixes. Removed random collision searches and unnecessary poll/retry projection work.

## Validation and outcome
48 focused tests passed across Message references, rendering, native tool rendering, Request evidence/resolution, and existing Agent suffix targeting. Seven selected process tests passed, covering suffix poll/retry/cancellation, coordinator reopen, requester authority, Message retry races and Answer retrieval. Typecheck, package dry-run, production dependency audit (zero vulnerabilities), and diff checks passed. Full integration suite was not run per repository guidance.

The final diff retains canonical Agent/session identity and source-derived Message IDs. No SQLite, durable counter, identity migration, or cross-Workflow transport is introduced. Issue #101 and PR #103 are updated to the agreed reference-ergonomics scope. The replacement is published as a new commit without rewriting branch history.
