# Agent switch spinner continuity

## Goal

Keep the current selector animating until a replacement Agent frame is ready to
take over the physical terminal. Selection must remain pending through that
handoff. Agent count must not determine whether loading feedback works.

## Scope and constraints

Change physical attachment sequencing and the completion signal for durable view
retargeting. Preserve terminal reply isolation, output backpressure, cancellation,
failure restoration, and Runtime retention. Do not change spinner cadence or add
a second loading UI. Leave unrelated source prototypes untouched.

## Evidence

A temporary reproduction combines the real selector with the existing physical
attachment test fixtures. With two children, blocked detachment, and no physical
backpressure, three selector frames are rendered in 246 ms and zero reach the
physical terminal. The result repeats. This proves a disconnected-output interval;
it does not establish the duration or every trigger of the reported live stall.

## Work plan

1. Add regression coverage at the existing selector/physical attachment boundary.
2. Prepare replacement output while the current attachment continues rendering.
   Publish the ready replacement before awaiting detached reconstruction.
3. Await presentation handoff before completing selection and releasing the
   previous Runtime's interactive retention.
4. Validate focused attachment/selector tests, a real PTY switch, and typecheck.
   Review cancellation and failure paths. Avoid the full integration suite.

## Progress

- Repeated the failing two-child reproduction without event-loop starvation or
  physical output backpressure.
- The combined real selector, durable view, and physical attachment regression
  first reproduced lost frames, then reproduced premature selection completion.
  Both now pass after fixing handoff sequencing and awaited retargeting.
- Focused coverage passes for cancellation, superseded preparation, backpressure,
  replacement resize, and Owner restoration. Typecheck passes.
- Real fullscreen PTY switching and independent child-mode switching pass.
- Independent Standards and Spec reviews pass after correcting premature success
  on failed attachment, making presentation readiness explicit, and removing the
  animation test's dependence on a fixed tick count.
- A cancellation-failure regression caught an unhandled rejection while earlier
  preparation was pending. Cancellation outcomes are now observed immediately
  while handoffs remain serialized; the Spec reviewer verified the correction.

## Final validation

- Focused selector, remote selector, view surface, PTY projection, and interactive
  presentation tests: 57 passed.
- Real fullscreen PTY switch between two Agent modes: passed.
- Independent child-mode switch through `/agents`: passed.
- `npm run typecheck` and `git diff --check`: passed.
- No full integration suite run.

## Outcome

Confirmed and repaired one child-to-child spinner freeze without requiring a
large roster. The old selector keeps emitting physical frames during preparation;
replacement output takes over before old detached reconstruction completes.
Selection awaits presentation completion and failure remains observable.

The duration and all possible triggers of the reported live stall remain
unmeasured. Physical setup's existing use of Control reinitialization completion
rather than an in-band PTY marker was reviewed as a separate possible first-frame
readiness issue and remains outside this change.
