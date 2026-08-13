# Preserve the native Owner Runtime across Run failure

## Goal

End a failed Owner Run without disposing Pi's process-owned native Owner session, then admit a successor Run in the same Runtime. Make Pi the sole disposer of that Runtime through its public session shutdown lifecycle.

## Intention

Separate Run lifetime from Runtime ownership. Coordination owns child Runtimes, but borrows the Owner Runtime from Pi. Run cleanup may dispose owned child Runtimes; it must retain a borrowed native-host Runtime until Pi shuts down or replaces the session.

## Scope & Constraints

- Add explicit internal Runtime ownership to `AgentRuntimeSupervisor`.
- Preserve native-host Runtime binding and subscription across Run failure and successor-admission failure.
- Preserve the observable `owner_host_binding` reason across successor Runs.
- Continue reporting/fencing the exact Run Failure and clearing its Run-scoped state.
- Move final Workflow cleanup to the public awaited `session_shutdown` lifecycle.
- Remove the `AgentSessionRuntime.dispose` replacement and its compatibility checks.
- Do not weaken genuine child Runtime cleanup.

## Work Plan

1. Add failing supervisor tests for Owner failure retention and successor admission.
2. Implement explicit `supervisor | native-host` Runtime ownership across all cleanup paths.
3. Add public quit lifecycle shutdown and delete the runtime dispose wrapper.
4. Update disposal tests to assert one Pi-owned native shutdown rather than arbitrary repeated direct disposal.
5. Run targeted tests, typecheck, fast suite, and relevant process tests.

## Validation

- `tests/run-projection-lifecycle.test.ts`
- `tests/owner-workflow.test.ts`
- `tests/owner-bootstrap.test.ts`
- `tests/host-shape.test.ts`
- `npm run typecheck`
- `npm run test:fast`
- targeted Owner replacement/shutdown process tests

## Progress

- [x] Minimized repro proves Owner Run Failure disposes the native session.
- [x] Regression tests reproduced the native Owner session disposal.
- [x] Ownership behavior implemented.
- [x] Public lifecycle owns final shutdown.
- [x] Typecheck, fast suite, targeted Owner lifecycle, Run Failure, fork, and disposal tests passed.

## Surprises & Discoveries

- The `runtime.dispose` wrapper did not participate in Run Failure cleanup; the failure path disposed `AgentSession` directly through `InProcessHostedRuntime`.
- Repeated direct `AgentSessionRuntime.dispose()` calls were only an accidental contract created by the wrapper. Pi's interactive host already serializes shutdown and should remain the sole native Runtime disposer.
- The first full operational-incidents test currently fails and does not terminate on the clean baseline as well. The targeted answer-obligated Owner Run Failure scenario passes with this change.

## Decisions

- `owner_host_binding` remains an observable Run retention reason, not the source of disposal authority.
- Runtime ownership is an internal supervisor invariant.
- Selected child retention remains temporary and orthogonal to ownership.
