# Visible native Agent rendering

## Goal and intention
Make physical visibility own native rendering. Hidden child sessions continue work, IPC and persistence without drawing frames or rebuilding an offscreen terminal. Preserve the visible view and loading feedback until replacement takeover.

## Scope and constraints
Issue #95. Keep xterm for startup diagnostics and test utilities; no generic hidden query responder, session restart, or transcript optimization (#94). Use public Pi TUI stop/start/renderNow APIs. Run targeted tests, never the full suite.

## Work plan
1. Read installed Pi lifecycle APIs and establish failing regression cases at the existing presentation/runtime/PTY seams specified by the issue.
2. Implement visibility transitions, remove detached reconstruction, retain PTY drainage, and separate dimensions from snapshots.
3. Verify real hidden child work/persistence and repeated physical handoff, input, resize, feedback and cleanup.
4. Measure several concurrent real children: render work, PTY bytes and Owner event-loop responsiveness. Keep measurements outside timing-sensitive tests.
5. Update accepted lifecycle docs; review and commit meaningful boundaries.

## Validation
Targeted native-presentation, PTY-projection, physical-attachment and real-child tests; typecheck; diff checks. Real-child benchmark evidence lives under agent artifacts. Structural invariants are assertions; elapsed times are observations only.

## Progress
- Issue requirements and current lifecycle documentation read.
- Code/tests delegated exclusively to visibility-implementation; docs and final review remain with this agent. Benchmark delegated separately with exclusive benchmarks/ ownership.
- Native visibility/PTY/attachment regression slices pass; real hidden-child repeated redraw test passes. Existing native-input integration tests are being converted from stale diagnostic snapshots to explicit physical displays.
- Four-child benchmark completed with durable transcript copies: all-hidden workload has zero render calls/PTY bytes for all children; one visible child has 76 probe renders and 15,013 bytes while three hidden children remain at zero. All eight responses persisted.
- IPC responsiveness p95: 1.387 ms all-hidden, 1.315 ms one-visible (24 samples each); parent event-loop maximum gaps 1.067/0.813 ms. These are proxy observations, not user-perceived latency or before/after speedups.

## Decisions
Native Pi UI data—not an emulated cell grid—is the source of redraw. Hidden PTYs remain drained. Startup negotiation is distinct from admitted hidden presentation.

## Surprises and discoveries
Native-input tests that previously used detached diagnostic snapshots must attach a physical test display. Keeping those snapshots live would contradict the visibility contract. Startup xterm remains diagnostic only after native admission.

## Outcomes
Implementation and targeted checks complete: 65 lifecycle/PTY/launch/hosted tests, 12 real process Runtime tests, 19 interactive-host/compaction/navigation tests and six selected Agent-view tests passed. Typecheck and diff checks passed. Full suite intentionally not run; remaining Agent-view cases and physical-display opt-ins in Owner fork/workflow, supervision and incident tests are adapted but not individually rerun. Evidence is stored under the agent artifacts output for pi-agent-coordination / 2026-09-09 / 95-visible-native-rendering, not in the repository.


## Retrospective
The production simplification removes the detached reconstruction module and most PTY mode machinery. Real native-input tests now use explicit physical terminal displays, rather than asking hidden diagnostic snapshots to behave like a selected view. Measured IPC responsiveness is a proxy; no human-perceived latency or broad freeze-elimination claim is made.
