# Passive selection with one Agent runtime

## Goal

Fix #69 without creating a second presentation-only `AgentSession`: selecting a Dormant Agent prepares and attaches its configured runtime, while actual input or Delivery activates work against that same runtime.

## Intention

Separate runtime availability from Run admission. `AgentSession` and its native projection belong to the Agent host while prepared; an exact Run is the transient work epoch layered over that runtime. Interactive selection retains the runtime, not a Run.

## Scope & Constraints

- Selection alone must not create a live Run, initialize residual Request retention, append transcript evidence, invoke the model, or create an Operational Incident.
- Do not suppress extension behavior. Input caused by `session_start`, slash commands, editor submission, or coordination Delivery may activate work normally.
- Dormant-to-live transition must retain the exact `AgentSession` and projection.
- A selected, never-activated runtime is disposed when deselected.
- Preserve exact-Run fencing, termination, failure, interruption, Delivery, and Operational Incident semantics.
- Remove the presentation-only extension/session path introduced for the attempted #69 fix rather than retaining compatibility logic.

## Work Plan

1. Add behavior-first regressions at the Agent view seam proving passive selection, extension-triggered activation, same-projection activation, and cold-recovery incident behavior.
2. Refactor `InProcessAgentHost` to distinguish a prepared runtime from an admitted Run.
3. Make selection prepare and attach the ordinary configured Agent runtime without Run admission.
4. Activate a prepared runtime for native Agent execution and coordination Delivery; initialize Run-scoped Request relationships only then.
5. Dispose a prepared runtime on passive deselection and remove dormant projection replacement/suppression machinery.
6. Update the glossary and lifecycle documentation to describe runtime preparation and state transition directly.

## Validation

- Focused Agent view, cold recovery, message, Run supervision, projection lifecycle, and Operational Incident tests.
- Full `npm test`.
- `npm run test:conformance`.
- `npm run typecheck` and `git diff --check`.

## Progress

- [x] Rejected the duplicate Dormant presentation/session design after review.
- [x] Regressions define passive selection, native extension activation, stable Runtime identity, and cold-recovery incident behavior.
- [x] Host distinguishes prepared Runtime ownership from exact Run admission and reuses the selected projection across transitions.
- [x] Presentation-only sessions, Dormant projection policy, input suppression, and obsolete native session selection were removed.
- [x] Glossary and lifecycle documentation describe Agent Runtime and exact Run separately.
- [x] Initial full tests, conformance, typecheck, package dry-run, and diff check were green.
- [x] Add the distinct human-facing `dormant` status.
- [x] Reproduce and fix both accepted reviewer findings at existing public seams.
- [x] Add focused clean-release Runtime identity coverage for the reviewer's residual risk.
- [x] Revalidate full tests, conformance, and typecheck after review fixes.

## Decisions

- Extension input is never classified by its origin for suppression. If Pi turns it into model work, it activates the Agent.
- Interactive selection is Runtime retention, not a Run Retention Reason; an otherwise releasable Run may end while the selected Runtime stays prepared.
- Projection identity remains stable across Dormant-to-live activation and selected Run failure.
- Invalid Runtime initialization closes the view because no usable Runtime exists to retain.
- Runtime configuration is resolved at Runtime preparation and remains stable across its exact Runs.

## Reviewer follow-up

Independent review found two bounded lifecycle races worth fixing: passive Runtime readiness can fail after projection publication but before a view surface subscribes, and shutdown fencing was not checked when a prepared Runtime admitted a Run. Both were reproduced before their fixes. The coordinator now observes the exact preparation promise and closes only its matching unusable attachment; this rejects the reviewer's broader alternatives of globally sticky projection failures or a new host callback. The host now fences Dormant-to-live admission before changing Run state or retention. A focused host regression also proves two clean Runs reuse one selected Runtime, session, projection, and preparation.

## Outcomes & Retrospective

The replacement design removed the presentation-only session, Dormant projection kind, origin marker, dormant input policy, projection replacement method, and obsolete native session-selection path. The production change deletes substantially more code than it adds. `AgentRun` remains only as an exact admitted-work epoch for fencing and supervision; Agent Runtime now owns the Pi session and UI lifecycle.

Validation: full `npm test` passed after review fixes; conformance passed 68/68; TypeScript and package dry-run passed. `npm audit` still reports the unchanged high-severity transitive `brace-expansion` advisory under the Pi host dependency.
