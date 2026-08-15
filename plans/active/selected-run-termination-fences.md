# Selected Run termination fences

## Goal

Make selected-Agent Run termination complete across Runtime initialization and in-flight native input, while retaining a ready selected Runtime for later successor work.

## Intention

A successful termination receipt must fence the exact Run and every native input submission accepted before that termination. It must not wait indefinitely behind startup UI. A ready selected Runtime remains attached and Dormant; an initializing Runtime that cannot safely be retained is cancelled and its unusable view closes.

## Scope & Constraints

- Preserve durable Agent identity, transcript evidence, Requests, descendants, and the existing successful termination receipt.
- Do not restore the removed `interactive_selection` rejection.
- Do not terminate a later successor when resolving a cancellation requested for an earlier starting Run.
- Keep initialization cancellation distinct from native-input fencing.
- Test observable behavior through the public `agent_control` and selected Agent presentation seams.
- Do not include the unrelated `AGENTS.md` worktree change.

## Work Plan

1. Add a process-backed regression test proving input already in selected-view preflight cannot admit a successor after termination.
2. Add a process-backed regression test proving termination cancels selected startup without waiting for blocked startup UI.
3. Implement an exact native-input submission fence across termination and successor admission.
4. Request starting-Runtime cancellation before entering its occupied Agent lane, then finalize the exact termination receipt in lane.
5. Close only an initializing selected view whose Runtime cancellation won; retain ready selected views.
6. Update the domain language and supervision documentation for initialization-time termination.
7. Run targeted tests, typecheck, and review the final diff.

## Validation

- New native-input preflight termination regression.
- New selected-startup termination regression.
- Existing selected live-Run termination conformance test.
- Existing Run supervision and Runtime projection lifecycle termination tests.
- `npm run typecheck`.

## Progress

- [x] Confirmed test seams from the accepted design: public `agent_control` behavior and selected Agent process/presentation lifecycle.
- [x] Native-input preflight and final-admission fence tests red, then green.
- [ ] Starting-Run cancellation test red, then green.
- [ ] Documentation updated.
- [ ] Targeted validation complete.

## Surprises & Discoveries

- The complete fence needs the exact terminal submission sequence at both the participant-input and final `agent_start` admission seams; queue clearing cannot see input still inside extension preflight.
- Pi can reach the tail participant input hook without the patched `InteractiveMode.getUserInput` lifecycle, so the child bridge binds the same terminal acknowledgment identity at both paths.

## Decisions

- A ready selected Runtime is retained after termination.
- If termination wins during Runtime initialization, initialization is cancelled and the not-yet-usable view closes rather than retaining a half-initialized Runtime or silently restarting it.
