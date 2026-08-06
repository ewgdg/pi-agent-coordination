# Inherit named inline extensions in fresh Agent Runs

## Goal

Implement GitHub issue #52 so a child, successor, or cold-recovered Agent Run inherits named inline Pi extensions by resolving their durable `<inline:name>` references against the current host factory registry, while file-backed inheritance and the existing Agent Identity schema remain unchanged.

## Intention

Keep extension references durable and host-independent, but keep extension implementations live and Run-local. One Pi-integration adapter will structurally validate the private `resourceLoader.extensionFactories` seam, partition effective extension references, and return the current named descriptors. Pi will invoke those factories with each fresh Run's `ExtensionAPI`; coordination will never copy loaded extensions, tools, handlers, commands, providers, or factory-local state.

## Scope & Constraints

- Implement issue #52 only. Do not redesign Pi's extension protocol, Agent configuration, cold discovery, provider registry, or Run lifecycle.
- Preserve `RuntimeConfigurationBaseline.extensions` and effective `extensions` as canonical string references.
- Treat only named descriptors as durably inheritable. A selected missing, duplicate, or anonymous inline reference must fail Run preparation.
- Keep initial child preparation before Child Identity commitment. A failed successor or cold-recovered startup must leave the existing durable Agent dormant.
- Resolve the registry on every Run preparation so successor and cold-recovered Runs use the current host descriptor and receive fresh factory-local state.
- Pass only file-backed references to `additionalExtensionPaths`; pass resolved named descriptors first and the fresh hidden role-bound coordination descriptor last to `extensionFactories`.
- Apply the partition at the shared configured-Run seam used by ordinary Agents and Moderators. This is the smallest generic resource-loading behavior and avoids leaving Moderator Runs broken when their inherited baseline contains the same named inline resource.
- Verify the actual Pi 0.83 `llama.cpp` descriptor against the already-shared `ModelRuntime`, including Owner command/provider availability after child startup and shutdown. Do not add a network dependency.
- Use public role-bound tools, concrete Pi sessions, persisted transcripts, and host conformance as the test seams. Direct private-member mutation is limited to structural host-shape rejection tests.
- Preserve the clean starting point at `4a444ca` and avoid adjacent issues #50 and #51.

## Work Plan

1. Extend the real test host to accept Pi inline descriptors and add a failing spawn regression that reproduces `<inline:llama.cpp>` being misrouted as a file path.
2. Add public behavior coverage for named tool/handler inheritance through a child and grandchild, distinct per-Run factory state, `extensions: "none"`, unchanged file-backed inheritance, actual `llama.cpp` behavior with the shared `ModelRuntime`, and pre-Identity rejection of missing, duplicate, and anonymous inline factories.
3. Add successor and cold-recovery coverage proving registry re-resolution, explicit unavailable delivery, durable Identity preservation, and dormancy when the required descriptor is absent.
4. Add one Pi-integration adapter for private-registry structural validation and current named-descriptor resolution. Extend live host admission to require the array and valid entry shapes.
5. Partition effective extension references in the shared configured-Run preparation path, pass each class to Pi's matching option, and retain canonical loaded references in the effective configuration.
6. Document named inline inheritance, fresh factory invocation, `none`, and failure semantics in `docs/agent-spawning.md`.
7. Run focused tests and typechecking while iterating. Then run independent Standards and Spec reviews against `4a444ca`, repair confirmed findings, and re-review.
8. Run the broad suite and package gates once after review fixes, move this plan to `plans/done/`, and commit semantically with `Closes #52` as the first body line.

## Validation

- Focused RED/GREEN: Agent Spawn, cold-host recovery, host-shape, and Pi extension/behavior conformance slices.
- Required issue gates: `npm test`, `npm run test:conformance`, and `npm run typecheck`.
- Final package gate: build, package dry run with packed-content inspection, production audit, source/build parity, and `git diff --check`.
- Independent Standards review against repository instructions, `CONTEXT.md`, current docs/plans, and established code conventions.
- Independent Spec review against issue #52 and the relevant host/package decisions in parent issue #34.

## Progress

- [x] Inspect issue #52, parent boundaries, current Run preparation/Identity ordering, cold recovery, Pi 0.83 factory/loader/provider behavior, and existing public test seams.
- [x] Fix the adapter and TDD boundaries.
- [x] Prove the current named-inline failure and add the acceptance regressions.
- [x] Implement factory resolution and host-shape admission.
- [x] Document the behavior.
- [x] Complete independent review, final validation, archival, and commit.

## Surprises & Discoveries

- Pi assigns anonymous inline references from the descriptor's one-based position in the complete factory array, while named descriptors use `<inline:name>` directly and receive no duplicate-name validation.
- Every Agent Run already receives the Owner's `ModelRuntime`. The `llama.cpp` factory creates a fresh closure-local native provider and registration replaces the shared runtime's current provider object; Run disposal does not restore or unregister it. Conformance must therefore cover actual Owner-visible behavior across child lifecycle, not only extension loading.
- Pi's network-enabled `ModelRuntime` persists the catalog refreshed by the Owner `/llama` command. A fresh child provider restores that catalog during offline service preparation, so lookup and inference remain available even though the provider instance changes.
- Cold discovery deliberately creates dormant records without preparing resources. Missing current factories must fail only when later input attempts to start the recovered Run, preserving valid durable Identity evidence.

## Decisions

- Put registry resolution in the shared `DefaultChildSessionFactory` configured-Run seam because fresh children, successors, cold-recovered Agents, and Moderators already converge there.
- Keep host-shape validation and Run-time resolution behind one adapter so no coordination or protocol module reads Pi's private member directly.
- Preserve Pi's complete named descriptor, including `hidden`, and let Pi create every loaded extension from the factory. Do not synthesize descriptors from loaded extension objects.

## Outcomes and retrospective

Issue #52 is implemented at the shared configured-Run preparation seam. Fresh children, grandchildren, successors, cold-recovered Agents, and Moderators now resolve durable named inline references against the current host registry, while file-backed references continue through Pi's path loader. Missing, duplicate, and anonymous references fail at the required Identity or dormant-successor boundary, and `extensions: "none"` excludes both inheritance forms.

The focused regression reproduced the former `<inline:llama.cpp>` file-path misrouting before the implementation. Final conformance uses Pi's actual built-in descriptor, a local mock llama router, the public `/llama` command, and real inference before child startup, from both Owner and child while live, and after child shutdown. Independent Standards and Spec reviews are clean after centralizing test tool execution and isolating private Pi package access in the Pi-integration adapter.

Final validation passed `npm test` (222 tests), `npm run test:conformance` (41 tests), `npm run typecheck`, `npm audit --omit=dev` with zero vulnerabilities, `npm pack --dry-run` with the new adapter included, and both diff checks. This source-shipped package has no build script or `dist/` tree, so there is no separate emitted-artifact parity gate.
