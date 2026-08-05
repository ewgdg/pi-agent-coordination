# Spawn one default child and deliver its Creation Request

## Goal

Let an authenticated ordinary Agent call `agent_spawn` to create one fresh, durable, context-isolated child Agent, commit the child and its Creation Request at one Identity boundary, start the child's first in-process Run, admit the Request as fixed Deferred Delivery, and expose the child to its Direct Spawner without exposing raw Pi runtime objects.

## Intention

Keep Pi transcripts authoritative and the live coordinator disposable. The committed native `agent_spawn` tool call is the only Creation Request source. The child Identity append ratifies both durable facts. Child startup and delivery admission happen afterward in one serialized lane, so failures can report partial outcomes without rollback or invented processing claims.

## Scope and constraints

- Register `agent_spawn` only in hidden extensions closed over an ordinary Agent identity. This default-child slice accepts required `request` plus optional `description`; caller, label, Workflow, Spawner, Agent IDs, runtime overrides, and delivery mode are not model-supplied.
- Resolve the exact committed assistant tool call to a `ToolCallPointer`. Derive the Request identity as unpadded base64url SHA-256 over the canonical NUL-separated message tuple.
- Validate and normalize metadata and the complete parent-derived runtime baseline before Identity commit. Use the default label `agent`; omit an absent description.
- Create a durable Pi session in the Workflow session directory. Do not fork, clone, or project the parent transcript or model context.
- Append one strict child `agent-coordination.identity` entry containing the child session identity, Workflow, Direct Spawner, Spawn source, and configuration baseline. Do not append another outbound Request record.
- After Identity commit, transfer exclusive transcript writing to the child's serialized live lane. Start and verify the Pi session, then admit one model-visible `agent-coordination.message-delivery` with fixed Deferred scheduling without an intervening Idle-close eligibility point.
- Preserve exact receipt meanings: `pending`, `created_unscheduled`, `not_created`, and `indeterminate`. No receipt claims Delivery commit, model processing, an Answer, completion, or usefulness.
- Keep child sessions and Run handles private. Extend role-bound observation with stable direct-child enumeration and bounded child status.
- Do not implement templates, per-spawn runtime overrides, general Message retry, Answer/cancellation, dormancy/restart, Run controls, selection/rebinding, cold-host rediscovery, or policy scheduling from later issues.

## Public test seams

1. Role-bound `WorkflowCoordinator` operations backed by real temporary Pi `SessionManager`s and `AgentSession`s: Spawn receipts, canonical transcript evidence, child runtime/context isolation, and passive observation.
2. Pi extension registration and authentication: a real committed native tool call reaches the caller-bound ordinary view; no model-supplied identity exists; child sessions receive their own hidden ordinary extension.
3. Durable transcript behavior: the child Identity and Message Delivery can be reopened and inspected from the real child session file.
4. Confirmed/uncertain boundary outcomes: controllable faults around the concrete Identity append, Run start, and delivery admission produce the exact public receipts and contradiction detection without a fake runtime backend.

## Work plan

1. Add strict shared protocol types and validators for tool-call pointers, deterministic Message identities, child Identity/configuration, and Creation Request Delivery.
2. Deepen the concrete in-process host and coordinator around private Agent records and serialized child lanes. Add the hidden Agent-bound extension and ordinary spawn/observe tool surfaces.
3. Implement the Spawn operation vertically: authenticate/resolve source, normalize metadata, snapshot and validate inherited resources, create the durable child transcript, append Identity, start the real child session, and admit Deferred Delivery.
4. Add focused integration slices for success, isolation, pre-Identity failure, post-Identity Run/admission failures, confirmation loss, contradictory source/Identity evidence, stable observation order, and child-initiated nested spawn registration.
5. Update concise user documentation, run focused tests/typechecking throughout, then the full suite/build/package/audit/diff validation once.
6. Run independent Standards and Spec reviews against the pre-change fixed point, fix findings, revalidate, and commit semantically with `Closes #36` in the body.

## Validation

- `node --test tests/agent-spawn.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm pack --dry-run`
- `npm audit --omit=dev`
- `git diff --check`

The success path uses a deterministic no-network provider that emits a real `agent_spawn` call, so the source pointer comes from Pi's committed transcript rather than a fabricated direct tool invocation. Boundary failure coverage continues to use concrete Pi sessions and the concrete host; fault controls only determine whether a real boundary confirms, rejects, or loses confirmation.

## Progress

- [x] Inspected issue #36 and its canonical refinements in issues #14, #20, #22, #25, #30, #32, and umbrella issue #34.
- [x] Confirmed the existing role-bound coordinator and real Pi session harness as the pre-agreed public seams.
- [x] Protocol identity and evidence slice.
- [x] Successful child creation, first Run, Deferred Delivery, and nested ordinary surface.
- [x] Failure receipts, contradiction validation, and passive observation.
- [x] Documentation.
- [x] Full validation: 25 tests, strict typecheck, build, package dry run, production audit, and diff checks.
- [x] Independent Standards and Spec review.

## Decisions

- Treat issue #36 as the default-configuration slice: required `request`, optional `description`, and fixed default label `agent`. Explicit labels, Agent Templates, and runtime overrides remain issue #42.
- After Owner Identity validation, make the package-loaded Owner extension hidden and bind its ordinary surfaces to an Owner-specific coordinator view. Every child gets a hidden inline extension closed over its own Agent identity and the same coordinator.
- Reuse the running Owner's model runtime and agent directory while creating fresh cwd-bound services and a fresh Pi session. Inherited ordinary resource selections are explicit; the public Owner bootstrap extension is excluded.
- Keep failure controls at concrete phase boundaries so integration tests can force specified receipts without introducing a backend abstraction.

## Outcomes and retrospective

Implemented the complete default-child slice. A committed ordinary-Agent tool call now creates one canonical child and Creation Request, starts a fresh isolated Pi session, admits the Request at the child's settled Idle boundary, and exposes only bounded status to its Direct Spawner.

Pre-Identity validation covers metadata, model availability, resources, tools, and skills. Boundary-controlled real-session tests cover confirmed failure, confirmation loss, and contradictory durable evidence across Identity, Run start, and Delivery admission. A real Pi resource reload test also confirms that the Owner's hidden role-bound surface rebinds without replacing the coordinator.

Independent Standards and Spec reviews reported no remaining findings. Final validation passed 25 tests, strict typechecking, build, package dry run, production dependency audit with zero vulnerabilities, and diff checks.
