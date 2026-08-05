# Ask the human structured Questions through native Pi interaction

## Goal

Implement issue #40 as a complete native Human Request tracer bullet: any Agent can block one exact Run on one or more structured Questions, the human answers through a request-specific Pi TUI surface, and only the matching committed native tool result becomes the Human Answer.

## Intention

Use Pi's existing sequential tool execution and native extension UI instead of introducing a generic wait protocol or another durable store. The committed `ask_user_question` call is the Human Request, its successful matching tool result is the sole Answer, and all pending interaction, partial selection, focus, and attention state remains volatile and exact-Run-bound.

## Scope and constraints

- Accept one or more strictly shaped `select_one`, `select_many`, or non-empty `text` Questions. Correlate Questions, options, and answers by immutable array position; introduce no Question or option identities.
- Derive one Human Request identity from the committed native tool-call pointer in the `human_request` domain.
- Preserve Pi's sequential tool barrier so later sibling calls cannot start before success or interruption settles the Human Request. Different Agent Runs may wait concurrently.
- Project exact live `input_required` attention without timeout, default Answer, automatic continuation, declared-wait state, or transcript reconstruction.
- Keep background attention passive. Only explicit human selection opens the request surface; one tab represents each Question and partial selections remain inside that live component.
- Treat submission as a candidate result only. Clear attention and enable continuation only after the matching successful native tool result process-commits.
- Let Escape abort and settle the exact live tool invocation so Pi commits one matching error result. Do not author a Human Answer, cancellation fact, user message, or lifecycle state.
- Fence the exact pending interaction when Run failure wins, close its UI, reject late submission, and never reconstruct it in a successor Run.
- Keep `agent_message`, Agent Request evidence, and their retention reasons separate from Human Requests.
- Preserve native transcript, editor contents, focus, queues, history, tool frames, footer, and session behavior.
- Do not add compatibility or migration logic for the discarded prototype Human Request bridge.

## Confirmed public test seams

1. A role-bound `WorkflowCoordinator` backed by real temporary Pi `SessionManager`s and `AgentSession`s for exact-Run attention, concurrent waiters, scheduling handoffs, and Answer/failure races.
2. The registered `ask_user_question` tool reached through committed native Pi tool calls for strict schemas, source-derived identity, the sequential barrier, and native success/error result ordering.
3. The request-specific native component plus a narrow real PTY workflow for multi-question tabs, transient partial state, passive background attention, occupied-editor Escape, and editor preservation.
4. Reopened complete transcript inspection for canonical Answer/interruption evidence and non-reconstruction, with concrete exact-boundary hooks only where a race cannot be deterministically observed through the higher seams.

## Work plan

1. Add the strict positional Human Question/Answer protocol and committed call/result inspection.
2. Add exact-Run Human Request coordination, `input_required` host state, committed-result reconciliation, failure fencing, and deterministic settlement dispatch.
3. Register the sequential `ask_user_question` tool and reconcile its committed result before sibling execution and before Steer freezing at `turn_end`.
4. Add passive attention presentation and the tabbed request component, with explicit selection, transient drafts, submission, Escape, and lifecycle-driven close.
5. Integrate Human attention into `/agents`, child startup, shutdown, and compact status rendering without exposing raw sessions or Run handles.
6. Add real-session and PTY tracer-bullet coverage for the accepted behavior, including two concurrent Agent waiters and both Answer/failure race orders.
7. Document the supported Human Request workflow under `docs/` and update the primary package guidance.
8. Run focused tests and typechecking throughout, then the full suite, build, package dry run, production audit, and diff checks once.
9. Run independent Standards and Spec reviews against `f61065f`, repair findings, revalidate, move this plan to `plans/done/`, and commit semantically with `Closes #40` as the first body line.

## Validation

- `node --test tests/human-request.test.ts`
- `node --test tests/human-request-pty.test.ts`
- `node --test tests/message.test.ts`
- `node --test tests/agent-request.test.ts`
- `node --test tests/agent-spawn.test.ts`
- `node --test tests/host-shape.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm pack --dry-run`
- `npm audit --omit=dev`
- `git diff --check`

## Progress

- [x] Inspected issue #40, its accepted design sources, current protocol glossary, Pi 0.83.0 APIs, and existing runtime/test seams.
- [x] Confirmed the four public TDD seams with the user.
- [x] Strict protocol and registered-tool tracer bullet.
- [x] Exact-Run attention, concurrency, scheduling, and race behavior.
- [x] Native tabbed presentation and real PTY validation.
- [x] Supported workflow documentation.
- [x] Full validation and independent Standards/Spec review.
- [x] Semantic commit.

## Decisions

- Keep Human Requests in a dedicated coordinator module. They are not Agent Messages and do not use Agent Request retry, delivery, cancellation, or `awaiting_answer`/`answer_owed` state.
- Reconcile successful result commitment before later sibling tool execution and again at `turn_end` before queued Steer becomes eligible; Deferred remains tied to later settlement.
- Use public Pi extension UI/TUI seams for attention and request presentation. Expand the private host bridge only if implementation proves those public seams insufficient.
- Use Pi's final awaited `message_end` hook only to turn a fenced candidate success into the native error result. Do not settle attention there; reconcile only after transcript append at the next tool start, `turn_end`, or `agent_end`.
- Keep exact race controls inside `HumanRequestBoundaryHooks`. The Spawn boundary exposes only the child identity and real session needed by the confirmed coordinator seam; it does not expose the production host or Run handle.
- Name the UI-submitted value `HumanAnswerCandidate`; reserve `HumanAnswer` for the validated successful result found during committed transcript inspection.

## Surprises and discoveries

- The current identity module already reserves the `human_request` derivation domain, and child tool selection already names `ask_user_question`; issue #40 completes those intentionally missing surfaces.
- `InProcessAgentHost` currently owns only one settlement callback. Human Request failure fencing must not replace the Message scheduler's callback, so lifecycle dispatch needs one ordered ownership seam.
- UI submission originally resolved the tool before a later Run fence could change the candidate result. A final pre-append guard is required so failure still wins until native result commitment, while post-append reconciliation remains the sole attention-clear boundary.
- Two default-labeled Agents with the same Question count produced identical `/agents` rows. Numbering the captured attention snapshot gives every selectable row one exact mapping without exposing protocol identity text.
- The system `script(1)` PTY is sufficient for the narrow real-terminal fixture; no terminal emulation dependency is required.
- Editing a previously confirmed text tab initially left its stale Answer candidate selected. Every text mutation now invalidates that candidate, and the PTY workflow navigates away and back before reconfirming the edited draft.
- A request-local pre-commit fence did not prove the required Run race. The concrete boundary now marks and aborts the exact Run, rewrites its pending candidate result to interruption, and proves that Run becomes dormant without model continuation.

## Outcomes and retrospective

Issue #40 is implemented as one Pi-native Human Request path. Strict committed-call/result validation, exact-Run attention and fencing, shared native presentation, Message scheduling boundaries, and successor non-reconstruction are covered through real Owner/child sessions and a real PTY.

Post-review validation passed: 75 tests, TypeScript build, package dry run, production audit with zero vulnerabilities, and diff checks. Standards review found and resolved domain-candidate naming, layout constants, and duplicated Run cleanup. Spec review found and resolved stale edited text candidates, missing PTY tab navigation, and a synthetic failure race that now fails and disposes the exact Run.
