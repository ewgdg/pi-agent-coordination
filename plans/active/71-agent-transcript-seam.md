# Agent transcript seam

## Goal

Introduce the read-only transcript boundary needed before non-Owner runtimes move out of process. Coordination and protocol evidence inspection must depend on an Agent-owned transcript, not an in-memory Pi `AgentSession` or `SessionManager`.

## Intention

Keep Pi transcript storage behind a deep, process-neutral read model. `AgentTranscript` requests a new snapshot from a `TranscriptReader` for each inspection. The current adapter reads a local `SessionManager`; a future file-backed reader can reopen the session file on every call without inheriting a live manager cache.

## Scope & constraints

- Preserve all behavior.
- Write contract tests first.
- Make `AgentRecord` own its transcript.
- Replace read-only `SessionManager` dependencies in coordination and protocol evidence helpers.
- Keep initial Owner, child, and Moderator Identity creation under local pre-launch `SessionManager` authority.
- Keep live transcript writes in the existing in-process host/session path; do not add synchronous remote writes.
- Do not change control-channel or process-runtime modules.
- Do not expose a read-only copy of the complete `SessionManager` API.

## Work plan

1. Define failing contract tests for fresh transcript snapshots and the local Pi adapter.
2. Add the process-neutral transcript deep module and local `SessionManager` adapter.
3. Attach transcripts to all `AgentRecord` construction paths.
4. Convert protocol evidence helpers and coordination callers to transcript snapshots.
5. Remove `requireLiveSession` calls used only to reach `sessionManager`.
6. Run focused tests, typecheck, full tests, conformance, and repository checks.

## Validation

- `node --test tests/agent-transcript.test.ts`
- Focused message, recovery, moderation, spawning, supervision, and workflow tests.
- `npm run typecheck`
- `npm test`
- `npm run test:conformance`
- `git diff --check`

## Progress

- [ ] Transcript contract tests committed red.
- [ ] Deep module and local adapter implemented.
- [ ] Coordination/protocol reads migrated.
- [ ] Full validation complete.

## Decisions

- One inspection is one coherent read value containing only session identity/location, header, physical entries, active branch, and model context.
- The `TranscriptReader` is called anew for every inspection; `AgentTranscript` owns no cache.
- Mutation is not part of this seam.

## Outcomes & retrospective

Pending.
