# Remove obsolete private Pi seams

## Goal

Delete private Pi integrations that the isolated-process architecture no longer needs while preserving the intended Owner and child behavior.

## Intention

Make host compatibility checks describe actual remaining dependencies rather than historical implementation details. Keep the Owner selector loading overlay active until child presentation is ready, ignore input during that loading state, and route input directly to the child only after physical attachment.

## Scope & Constraints

Remove:

- prioritized mutation of private `TUI.inputListeners`;
- private binding-only extension refresh;
- unused run-admission patch;
- unused committed-input persistence helper;
- participant native selector prototype gate, retaining public lifecycle cancellation;
- private host-shape requirements made obsolete by those removals and other verified-unused checks.

Keep the Owner runtime `dispose` replacement for now. Pi's public `dispose()` is not idempotent and repeated host disposal is an existing tested requirement; shutdown lifecycle alone does not replace that ownership safely.

Retain for later discussion:

- interactive runtime/TUI capture;
- private committed-input continuation;
- exact child interactive input and compaction observation.

Do not preserve loading-time keystrokes. The selector already disables input while selection is pending.

## Work Plan

1. Adjust Agent-view handoff tests to specify that Owner presentation remains active and loading-time input is ignored until child presentation is ready.
2. Simplify physical terminal attachment and delete the prioritized-listener adapter.
3. Delete binding-only refresh and make the capture bridge invoke native binding directly.
4. Delete unused private helpers and remove the participant selector patch.
5. Narrow host-shape validation and its conformance tests to remaining actual dependencies.
6. Run targeted tests, typecheck, then the full suite if targeted validation passes.

## Validation

- `tests/agent-view-surface.test.ts`
- `tests/owner-bootstrap.test.ts`
- `tests/host-shape.test.ts`
- participant policy tests discovered during implementation
- `npm run typecheck`
- `npm test`

## Progress

- [x] Scope agreed.
- [x] Handoff behavior specified and implementation simplified.
- [x] Obsolete integrations deleted.
- [x] Host compatibility surface narrowed.
- [x] Targeted validation and the full fast suite passed.
- [ ] Full process suite completed; the existing process suite does not terminate reliably as one command in this environment.

## Surprises & Discoveries

- The full process suite printed an existing Agent-view failure and then hung. The same test fails unchanged on the clean baseline, so it is not attributed to this change.
- `interactive-host-conformance.test.ts` also does not terminate in isolation in this environment. Targeted child `/reload`, Owner fork, process-runtime, and session-factory coverage passed.

## Decisions

- Loading-time input is ignored rather than buffered for later child delivery.
- `/reload` uses Pi's native retained bindings and intentional `session_start(reason: "reload")`; no private binding-only refresh is needed.
- Native session replacement creates a fresh session and uses ordinary binding.
- Retain coordinated `runtime.dispose` wrapping: current Pi disposal is not idempotent, while callers and tests require repeated disposal to clean up exactly once.
