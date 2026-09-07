# Configurable conversation forks

## Goal and intention
Make conversation inheritance independent of Runtime configuration, using one flat agent_spawn object.

## Scope and constraints
Preserve unconfigured fork startup and copied-evidence boundaries. Apply existing Template then config resolution to configured forks, including successor/cold recovery. No full suite.

## Work plan
1. Add failing schema, validator, configured-fork Runtime and recovery coverage.
2. Remove input prohibitions and limit parent active-tool preservation to unconfigured first forks.
3. Update maintained guidance, run focused tests and typecheck, commit.

## Validation
Target agent-spawn-input, participant-tool-registrar, fork/successor agent-spawn tests and cold-host fork recovery; npm run typecheck.

## Progress
Inspected Pi README/SDK/session format and existing preparation/recovery paths. Runtime already overlays captured Template then canonical config; first-fork active-tool override is the runtime conflict.

## Outcomes and verification
Implemented flat object schema, independent fork configuration, and scoped first-fork active tool preservation. Existing common preparation already handles Template/config precedence, successor re-preparation, and cold recovery; no duplicate recovery mechanism was needed.

Tests first demonstrated validator/schema/configured-fork failures. Passing focused checks: agent-spawn-input and participant-tool-registrar (23 tests); fork prefix/cache affinity, configured isolated/fork successors, prefix tamper/handoff invariants, and configured cold recovery. Typecheck passes.

A broader fork-name selection exposed an existing unrelated assertion mismatch in `copied coordination evidence grants no authority or obligations to a conversation-fork child`: expected no-active-Request error, actual unknown delivered Request. Reproduced with all task-modified production files restored temporarily to HEAD; left untouched as outside scope.
