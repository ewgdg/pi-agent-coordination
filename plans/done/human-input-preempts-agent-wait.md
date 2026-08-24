# Goal

Allow primary interactive human input directed at an Agent parked in `agent_wait` to resume that exact Run without waiting for every outbound Agent Answer.

# Intention

Human direction must remain actionable while an Agent is performing a strict fan-in. This is Agent Wait preemption, not Run interruption or Request cancellation.

# Scope and constraints

- Primary interactive input preempts the selected Agent's parked Agent Wait.
- Explicit follow-up input retains native queued-follow-up behavior and does not preempt.
- Reuse the non-error `{ "disposition": "preempted" }` result.
- Preserve every outstanding Request and undelivered Answer.
- A complete Answer aggregate wins at the preemption race boundary.
- Cover both the continuously bound Owner and an interactively selected child through public lifecycle/input seams.
- Do not extend preemption to ordinary Agent Messages.

# Work plan

1. Add one failing Owner input integration test at the native input/lifecycle seam.
2. Implement the smallest Agent Wait human-input preemption path with aggregate-first arbitration.
3. Add one failing selected-child integration test, then make the shared path pass.
4. Add a focused explicit-follow-up regression if existing coverage does not prove non-preemption.
5. Update model-facing guidance and domain/user documentation.
6. Run focused tests, typecheck, diff checks, and the fast suite if focused validation stays within scope.

# Validation

- Focused Agent Wait and interactive input tests.
- `npm run typecheck`
- `git diff --check`
- `npm run test:fast` when ready to finish.

# Progress

- Added the failing Owner tracer at Pi's native input seam.
- Generalized Agent Wait preemption and connected primary interactive input without capturing Pi's input pipeline.
- Verified the same behavior through a selected child's physical projection.
- Added an observable regression proving explicit follow-up remains queued until primary input ends the Wait.
- Updated model guidance, user documentation, and the domain glossary.
- Completed focused process validation, the fast suite, typecheck, and diff checks.

# Surprises and discoveries

- Returning `continue` from the input hook is essential. It preserves Pi's later skill and prompt-template expansion while the Wait reacquires execution capacity.
- The existing lifecycle seam already excludes explicit follow-up input before coordination sees it. The integration regression now proves that behavior at the parked Owner interface.

# Decisions

- Human input uses the existing Preempted result rather than adding another result variant.
- Explicit follow-up remains the opt-in way to queue input after the current turn.
- Human and inbound-Request preemption share aggregate-first arbitration; only inbound Requests require a reserved Delivery.

# Outcomes and retrospective

Primary Enter input now preempts a parked Agent Wait for both the Owner and a selected child. The next model turn sees the Preempted result together with the user message. Outstanding Requests and Answers remain intact, complete aggregates still win the race, follow-up input stays queued, and ordinary Agent Messages still do not preempt.

Validation passed:

- `npm run test:fast`
- `npm run typecheck`
- `git diff --check`
- Complete `owner-settlement-parking.test.ts`
- Focused selected-child, inbound-Request, aggregate-race, and exact-Run-fence Agent Wait tests
