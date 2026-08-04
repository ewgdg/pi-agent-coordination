# Boot an Owner-only Workflow on a compatible Pi host

## Goal

Ship the first production slice of `pi-agent-coordination`: loading the package in an interactive Pi TUI adopts or validates the current session as the Workflow Owner, retains that native `AgentSession` as the Owner Run, exposes its live semantic state through a role-bound coordinator and `/agents`, and disposes the host exactly once on orderly shutdown.

## Intention

Keep Pi authoritative. Coordination adds one durable Owner Identity entry and one volatile host/coordinator projection; it does not copy transcript state, replace native interaction, or introduce a backend abstraction. Compatibility is proven by the complete required Pi integration shape, never by a version allowlist.

## Scope and constraints

- Activate only for `ctx.hasUI && ctx.mode === "tui"`. Headless print, JSON, and RPC runs must create no coordinator, lane, timer, command, or tool.
- Verify the complete structural Pi integration shape before creating a runtime resource or installing a partial bridge. Report the first missing or malformed seam by canonical member name.
- Use the running Pi module world for constructors and runtime values. Pi packages are peers; concrete development versions are conformance fixtures only.
- Adopt a transcript with no current-scope coordination bootstrap by appending exactly one strict `agent-coordination.identity` entry. Validate an existing matching Owner bootstrap exactly. Reject child or Moderator bootstrap evidence instead of reclassifying it.
- Owner metadata is fixed to label `owner` with no description. The immutable baseline captures the current cwd, model, thinking level, ordinary active tools, skills, and extensions.
- Keep the raw Pi runtime, session, services, and transcript manager private. Tools and presentation receive only a role-bound `WorkflowCoordinator` view.
- Preserve native transcript, editor, history, queues, tool rendering, footer, and session interaction.
- Fence new admissions during orderly shutdown and memoize the one Owner disposal path. Make no graceful-end claim for abrupt process loss.
- Do not implement child spawning, delivery, requests, policy, moderation, selection/rebinding, or richer presentation from later tickets.

## Public test seams

1. The Pi extension activation boundary: TUI startup versus headless modes, tool/command registration, readiness, and failed startup cleanup.
2. The role-bound `WorkflowCoordinator` view: Owner self-observation, immutable identity/configuration, live semantic Run projection, and shutdown fencing.
3. Real Pi transcript/session behavior: bootstrap append/reopen/validation, retained native interaction, and exactly-once repeated shutdown.
4. Structural host admission: canonical diagnostics for every required missing or malformed member.

## Work plan

1. Scaffold the installable TypeScript package with Pi peers and a pinned current development cohort.
2. Add one failing integration test for compatible interactive bootstrap, then implement the smallest host preflight, transcript bootstrap, retained Owner Run, coordinator, and extension path that passes it.
3. Add vertical tests and implementation for strict shape rejection and rollback, existing bootstrap validation, child/Moderator rejection, self-observation, native interaction preservation, headless non-activation, and repeated shutdown.
4. Add concise package documentation for installation, TUI-only behavior, and the compatibility contract.
5. Run focused tests after each slice, then full tests, typecheck, package build/pack verification, and `git diff --check`.

## Validation

- `npm test`
- `npm run typecheck`
- `npm run build`
- `npm pack --dry-run`
- `npm audit --omit=dev`
- `git diff --check`
- live Pi `0.83.0` TUI boot, `/agents`, and orderly exit using the built extension

The integration suite instantiates real `SessionManager` and `AgentSession` values from the pinned running Pi module world with a deterministic no-network model. Shape fixtures remove required seams, while behavioral assertions stay at the extension/coordinator boundary.

## Progress

- [x] Inspected issue #35, the accepted architecture and integration-shape decisions, current main, and prior prototype evidence.
- [x] Confirmed public test seams from the issue and repository Testing Decisions.
- [x] Package scaffold and compatible interactive tracer test.
- [x] Owner bootstrap and retained-run coordinator.
- [x] Rejection, headless, native-interaction, and shutdown slices.
- [x] Documentation and full validation.
- [x] Independent Standards and Spec review, followed by a TUI-only bridge correction.

## Decisions

- Pin the current published Pi `0.83.0` cohort as a development fixture while declaring runtime peers with `*`; `VERSION` remains diagnostic only.
- Treat `/agents` as an Owner-only initial view in this ticket. Agent selection and child rows belong to later tickets.
- Keep the implementation greenfield. Prior prototypes inform observable contracts only.
- Keep bridge and coordinator ownership in process-global weak registries so resource/module reload re-registers surfaces without stacking private patches or shutdown wrappers.
- Capture the live runtime only from `InteractiveMode.bindCurrentSessionExtensions`, Pi's first TUI-only host seam; headless `setRebindSession` calls must remain native and unobserved.

## Surprises and discoveries

- Main intentionally contained no package scaffold or production source; issue #35 establishes both.
- The accepted Pi fixture advanced from `0.82.1` to `0.83.0`, so the structural contract was checked against the current published module world before implementation.
- Node 22 source tests do not resolve emitted `.js` specifiers to TypeScript sources; TypeScript's `rewriteRelativeImportExtensions` keeps source tests executable while package output uses standard `.js` imports.
- Pi reports extension handler failures through its native extension-error path instead of rejecting `bindExtensions`; rejection tests therefore assert the canonical visible error and absence of partial tools/commands.
- Module re-evaluation initially stacked the bridge patch. A reload-level regression test drove process-global idempotent ownership.
- Independent review found that capturing through `AgentSessionRuntime.setRebindSession` also inspected and retained print, JSON, and RPC runtimes. A headless regression test drove capture into the TUI-only binding seam and made runtime lookup weak.

## Outcomes and retrospective

Issue #35 is implemented as a greenfield installable package. Interactive Pi boot creates or validates one fixed Owner Identity, retains the native Owner session behind a role-bound coordinator, exposes `agent_observe` and `/agents`, preserves native prompting, and memoizes orderly disposal. Headless modes remain inert. Independent Standards and Spec review passes after the bridge correction. The full suite passes 13 tests, strict typechecking, build, package dry-run, production-dependency audit, diff checks, and a live Pi 0.83.0 TUI smoke run.
