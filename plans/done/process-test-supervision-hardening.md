# Prevent orphaned process-test workers

## Goal

Ensure interrupted or timed-out process-heavy tests cannot leave Node workers or detached Pi-style descendants running.

## Intention

Put the safety boundary above per-test cleanup. Every suite run gets a bounded Node test deadline, while an asynchronous supervisor owns signal handling and places the stopped test-runner root into a dedicated cgroup-v2 subtree before it can create workers. Detached and reparented descendants therefore remain killable as one owned unit.

## Scope & Constraints

- Preserve fast/process suite classification and concurrency.
- Cover detached descendants outside the test runner's process group.
- Admit the test root before it can fork, so no descendant escapes ownership.
- Retain a start-time-checked process-tree fallback where delegated cgroup-v2 creation is unavailable.
- Keep focused process-file execution under the same supervision.

## Work Plan

1. Reproduce top-level runner termination with a temporary hanging test worker and detached descendant.
2. Replace blocking `spawnSync` with an asynchronous signal-aware supervisor.
3. Add default per-test deadlines and focused `--file=` selection.
4. Validate the regression, one supervised process test, typechecking, and process-table cleanup.

## Validation

- `node --test --test-concurrency=1 --test-reporter=spec tests/run-test-suite.test.ts`
- `node tests/support/run-test-suite.ts fast --file=run-test-suite.test.ts`
- `node tests/support/run-test-suite.ts process --file=agent-request.test.ts --test-name-pattern='retired Delivery dispatch callback'`
- `npm run typecheck`
- `git diff --check`

## Progress

- [x] Deterministic sub-second regression reproduced all three survivors: Node test runner, file worker, and detached descendant.
- [x] Async cgroup-v2 supervisor, external hard-kill guardian, and process-tree fallback implemented.
- [x] Fast/process per-test deadlines implemented.
- [x] Focused supervised file selection documented.
- [x] Focused validation passed with no surviving fixture processes.

## Decisions

- Fast tests default to 5 seconds; process tests default to 30 seconds. Explicit per-test timeouts remain available for justified longer scenarios.
- Start the test runner through a stopped shell, move that exact root into a dedicated cgroup-v2 subtree, then continue into Node. Workers and detached PTYs inherit ownership before they can fork.
- On wrapper termination, signal the Node test runner first, allow a short cleanup grace period, then use `cgroup.kill` for every survivor. Ordinary success, failure, and Node test timeout also empty the cgroup before returning.
- Start a detached guardian outside the test cgroup before admitting work. It binds the supervisor PID and `/proc` start time, then empties the cgroup if the supervisor is directly SIGKILLed, even when a test worker is CPU-blocked.
- The `/proc` fallback continuously captures descendants and includes process start time so a recycled PID cannot receive cleanup signals.

## Outcomes & Retrospective

The original failure was architectural: `spawnSync` prevented the wrapper from handling SIGTERM, so an external timeout escalated and orphaned the test runner before worker cleanup could run. The runner is now asynchronous, isolates terminal signal ownership, contains all Linux descendants in a dedicated cgroup, and uses an external guardian to empty that cgroup even after direct supervisor SIGKILL. It cleans ordinary exit and termination, applies internal test deadlines before external timeout escalation, supports concurrent supervised runs, and supports supervised single-file process-test runs.
