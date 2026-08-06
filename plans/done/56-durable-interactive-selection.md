# Bind native Interactive Selection to durable Agent identity

## Goal

Implement issue #56 so Pi's native transcript/editor selection follows one durable Agent across replaceable Run and `AgentSession` incarnations. A selected Dormant Agent remains inspectable, and the first native editor Message or an ordinary Message starts exactly one successor and repairs the native binding.

## Intention

Keep durable Agent identity as the presentation choice while treating every concrete Pi session as a replaceable binding. Serialize selection, Run creation, native input admission, ordinary Message startup, and supervisor termination through existing Agent lanes. A dormant presentation binding may render the transcript and accept presentation commands, but must never invoke the model or become coordination authority.

## Scope & Constraints

- Store Interactive Selection as Agent identity plus the exact current presentation binding. Same-Agent selection is a no-op only when both still match the coordinator's current binding.
- Keep `/agents` focus passive. Enter selects the focused Agent deliberately; Dormant Enter binds its transcript/editor without starting a Run, appending evidence, or invoking the model.
- Admit the first ordinary native editor Message for a selected Dormant Agent inside its serialized lane. Start one fresh successor, rebind Pi, commit the exact input once through that successor, then permit execution.
- When an ordinary Message starts a successor for the selected Agent, repair the native binding to that session automatically before Delivery can use it.
- End failed Runs exactly and do not replay work. Preserve Agent selection by replacing stale/disposed native presentation with a dormant binding; later native input or ordinary Message may start a successor.
- Reject ordinary `agent_control({ operation: "terminate" })` for the currently selected Agent with a typed `interactive_selection` receipt. Keep interruption available.
- Serialize termination and selection changes at the target Agent lane. A completed deselection removes the guard and permits later exact-Run termination.
- Preserve coordinated shutdown and incompatible-host cleanup as dedicated lifecycle paths that may end selected Runs.
- Never transfer queues, Holds, scheduling, Retention Reasons, or exact-Run state to a successor.
- Keep Pi transcripts authoritative. Do not append selection, dormant presentation, Run lifecycle, or rebinding evidence.
- Do not expand #56 into selector layout, workflow policy, recovery, or general host lifecycle changes.

## Confirmed Public Test Seams

1. Registered `agent_control` and `agent_message` tools over real bound Pi sessions for typed receipts, exact-Run ordering, Message-started successors, and automatic rebinding.
2. Native `/agents` and the real PTY editor for passive focus, Dormant Enter, first editor submission, selected Run failure, deselection, and same-Agent repair.
3. Pi transcript inspection as authoritative proof that native input committed to the selected Agent exactly once and never to a stale presentation session.

Tests will not call private coordinator or host methods, mock internal collaborators, or substitute direct `AgentSession.prompt()` for the issue's terminal-editor regression.

## Work Plan

1. Deepen Interactive Selection into one small interface that reports selected Agent identity, compares an exact presentation binding, and activates a replacement binding.
2. Add a presentation-only session path for Dormant Agents. It must expose transcript/editor selection and `/agents`, intercept ordinary interactive input, and fail closed instead of invoking the model as an Agent Run.
3. Route selected native input through the Agent lane. Reuse exact-Hold resumption for held live Runs; otherwise start or reuse the current Run, rebind if needed, and dispatch one exact native Message with transcript-commit proof.
4. Notify selection whenever a successor starts or a selected Run ends. Repair to the current live session or a dormant presentation binding without changing Agent selection.
5. Guard ordinary termination inside the target Agent lane by current Interactive Selection identity and extend the receipt contract with typed rejection. Preserve interruption and dedicated shutdown paths.
6. Add the real PTY regression path for Dormant selection and editor submission, failure without replay, successor input, and transcript exact-once evidence.
7. Update `CONTEXT.md`, selector documentation, and Run-supervision documentation with the corrected identity-based design.
8. Run independent Standards and Spec review against the pinned base, repair findings, then complete the full test, typecheck, build, package, audit, and diff gate once.
9. Move this plan to `plans/done/` and commit semantically with `Closes #56` as the first body line. Do not push without separate authorization.

## Validation

- Focused red-green slices in `tests/run-supervision.test.ts`, `tests/interactive-host-conformance.test.ts`, and `tests/coordinated-workflow-pty.test.ts`.
- `npm run typecheck` during implementation.
- Final review before broad validation.
- `npm test`
- `npm run typecheck`
- `npm run build`
- `npm pack --dry-run`
- `npm audit --omit=dev`
- `git diff --check`
- Inspect dry-run package contents for current source/docs and stale compiled artifacts.

## Progress

- [x] Read issue #56, parent #34, prerequisite #41, selector #50, repository guidance, current domain language, prior ExecPlans, current Pi 0.83 host behavior, and exact-Run implementation memory.
- [x] Confirmed the registered-tool, native PTY, and transcript-evidence seams with the user.
- [x] Durable selection and presentation binding slice.
- [x] Native dormant input and successor rebinding slice.
- [x] Interactive termination guard and race slice.
- [x] Run failure and same-Agent repair slice.
- [x] PTY regression coverage and documentation.
- [x] Independent Standards and Spec review with all findings resolved.
- [x] Final validation, archived plan, and semantic issue-closing commit.

## Decisions

- Durable selection and exact presentation binding are separate facts. Agent identity decides who owns the editor; a session reference decides whether Pi is currently bound correctly.
- A presentation-only session is not a Run. It can render the transcript and route native presentation actions, but ordinary text must be handled by the coordinator before Pi can append or invoke the model.
- Selection repair occurs from coordinator-owned Run lifecycle transitions, not by polling Pi runtime state or treating runtime session identity as Agent state.
- Termination rejection is an expected receipt, not a thrown tool error. Its linearization point is inside the target Agent lane.

## Surprises & Discoveries

- Pi's normal idle terminal loop resolves editor input first and calls `runtime.session.prompt()` afterward. A presentation binding can therefore intercept the same native `input` seam, but commands handled before that seam need an explicitly limited presentation extension surface.
- Current same-Agent selection compares only Agent identity, so it cannot repair a disposed or superseded session incarnation.
- Current failure cleanup disposes the exact Run while Pi can still point at it. Interactive selection must participate in the end transition instead of relying on Retention Reasons, because terminal failure deliberately bypasses them.
- Transactional rollback is safe only while the previous binding will remain alive. Failure cleanup needs a disposal-aware replacement that commits a Dormant binding even when native rebinding cannot be confirmed, then leaves same-Agent selection able to repair it.
- Rebinding an unconfirmed exact session is not a replacement of ownership. Successful or failed repair must not release the same presentation session it is trying to preserve.

## Outcomes & Retrospective

- Interactive Selection now follows durable Agent identity across live Run sessions and presentation-only Dormant sessions. Explicit selection stays passive; native editor input or ordinary Message starts at most one successor and repairs Pi before execution.
- Ordinary termination is rejected for the selected Agent with the typed `interactive_selection` receipt, while interruption and dedicated shutdown paths retain their existing authority.
- Failure recovery moves Pi off the ending Run before disposal. A failed native rebind leaves a diagnostic and an unconfirmed Dormant binding that same-Agent `/agents` selection can repair without disposing the presentation.
- Public-seam coverage exercises registered tools, native `/agents`, real PTY editor input, Pi runtime diagnostics, and transcript exact-once evidence. Independent Standards and Spec reviews both passed with zero remaining findings.
- Final validation passed 241 tests, typecheck, the optional build step, `npm pack --dry-run`, production dependency audit with zero vulnerabilities, and diff hygiene. The 72-entry package contains current source and documentation with no stale `dist/`, tests, or plan artifacts.
