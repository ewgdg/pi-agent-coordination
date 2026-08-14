# Test Owner host cleanup

## Goal

Every Owner host acquired by a Node test is disposed even when the test fails before its explicit cleanup line.

## Intention

Make failure-safe cleanup a property of the test-host factory rather than a convention each test can forget. Keep standalone PTY fixtures explicitly responsible for their own lifecycle.

## Scope & Constraints

- Cover `createTestOwnerHost`, `createUnboundTestOwnerHost`, and `createPiCliTestOwnerHost`.
- Shut down manually constructed Workflow Coordinators before their Owner Runtime.
- Do not alter production runtime lifecycle.
- Preserve deliberate early disposal where shutdown is observable test behavior.
- Standalone fixture programs must not auto-dispose when their module finishes initializing.

## Work Plan

1. Add a failing contract test proving each normal factory disposes its host after the acquiring subtest.
2. Require the acquiring `TestContext` and centralize cleanup registration in `tests/support/pi-host.ts`.
3. Add a host-owned deferred cleanup stack and a managed Workflow Coordinator test factory.
4. Add an explicitly manually managed unbound factory and switch the four standalone PTY fixtures to it.
5. Remove redundant success-path cleanup hooks.
6. Run targeted cleanup, reported regressions, process conformance, typecheck, and relevant suites.

## Validation

- Cleanup contract test passes for bound, unbound, and Pi CLI factories.
- The reported operational-incident test passes and exits.
- The reported Agent-view test passes and exits.
- Interactive-host conformance passes 5/5 and exits.
- Fast suite passes.
- Typecheck and `git diff --check` pass.
- Full process-suite validation remains obstructed by unrelated existing failures in Agent-view and PTY tests; an isolated file run also showed the operational-incident file exceeds a 35-second diagnostic timeout after its first 18 passing tests.

## Progress

- [x] Design selected.
- [x] Contract test red, then green.
- [x] Factory cleanup implemented and enforced by its required `TestContext` argument.
- [x] Manually constructed Workflow Coordinators use host-owned deferred cleanup.
- [x] Fixtures made explicitly manual.
- [x] Redundant cleanup hooks removed.
- [x] Relevant validation complete.

## Surprises & Discoveries

- Node test cleanup hooks execute in registration order. Registering an ordinary `t.after` inside the host factory would run before gate-release hooks registered later by a test. The host therefore owns a LIFO deferred-cleanup stack, which releases test gates and shuts down Workflow Coordinators before disposing the Runtime.
- Calling the module-level `after()` helper from an imported support module does not bind cleanup to the acquiring nested test. Passing `TestContext` is required for exact test ownership.

## Outcome

Owner-host cleanup is now mandatory at the factory boundary. Every normal test-host call must provide its acquiring `TestContext`, and the factory registers failure-safe disposal immediately. Standalone PTY programs use a separately named manual factory, making the lifecycle exception explicit.
