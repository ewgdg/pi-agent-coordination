# Complete Agent Request, Answer, retrieval, and cancellation

## Goal

Implement issue #39 as a complete transcript-backed Agent Request protocol: immutable Requests, exactly one correlated Answer, requester-driven Answer Retrieval, one-hop Request Cancellation, and exact live Run retention across delivery and release races.

## Intention

Extend the working Message path instead of adding a second protocol store. Pi tool calls/results and Message Delivery entries remain the only durable authority. The requester and responder host lanes independently serialize their local facts, while volatile scheduling remains disposable and explicit retry remains the only recovery mechanism.

## Scope and constraints

- Add `request`, `answer`, and `cancel` operations to `agent_message`; retain `send`, `poll`, and `retry`.
- A normal Request may be Deferred or Steer at authoring. Answers and Request Cancellations use fixed Steer scheduling. Creation Requests remain fixed Deferred.
- Treat Request, Answer, and Cancellation identities as their source-derived Message identities. Do not add UUIDs, delivery-attempt identities, lifecycle state, a mailbox, or a reconstructed obligation graph.
- Track `awaiting_answer` and `answer_owed` per exact Request so resolving one relationship cannot release a Run retained by another.
- Let valid custom Message Delivery prove ordinary Request, Answer, and Cancellation delivery. Let a requester's native retry result be the sole additional Answer Delivery form.
- Serialize first-Answer-wins and Answer-versus-Cancellation Delivery in the responder lane. Serialize Answer Delivery versus Cancellation commit in the requester lane. Do not claim a cross-Agent transaction, remote revocation, tool abortion, or effect rollback.
- A Cancellation delivered before its Request suppresses later Request Delivery. Cancellation remains one hop; downstream cancellation requires independently authored Requests.
- After child Identity commit, Creation Requests use the same lookup, poll, retry, Answer, retrieval, cancellation, and retention behavior as ordinary Requests.
- Keep protocol evidence parsing, live coordination, scheduling, Run retention, tool presentation, and tests in focused modules. Do not retain compatibility or migration logic.

## Public test seams

The accepted #37/#38 seams remain the agreement for this extension:

1. Role-bound `WorkflowCoordinator` views backed by real temporary Pi `SessionManager`s and `AgentSession`s for Request receipts, retention, authorization, races, dormant restart, and release handoffs.
2. The registered `agent_message` tool reached through committed native Pi tool calls for strict schemas, hidden caller authentication, source-derived identities, native retrieval results, and rendering.
3. Reopened complete transcript trees for canonical source/result/Delivery validation, first-Answer-wins, duplicate rejection, Creation Request parity, and requester-visible Answer Delivery proof.
4. Existing concrete boundary hooks only where confirmation loss or an exact admission/commit/release ordering cannot be deterministically observed through the higher seams.

## Work plan

1. Add strict Request/Answer/Cancellation source and Message Delivery representations, canonical evidence inspection, correlated Answer lookup, and native Answer Retrieval proof parsing.
2. Generalize exact-Request live retention and scheduling terminal checks so Request Delivery establishes an obligation, Answer/Cancellation resolution removes only the matching relationship, and cancellation-before-request suppresses pending delivery.
3. Implement Request authoring and Creation Request lookup/poll/retry vertically through the role-bound coordinator and registered tool.
4. Implement first-Answer-wins, immutable Answer routing, fixed-Steer scheduling, lost return Delivery, responder retry, requester retrieval, and requester release handoff.
5. Implement requester-only Cancellation, same-identity retry, all independent requester/responder lane orderings, dormant participant restart, and cooperative one-hop semantics.
6. Update compact native rendering and feature documentation under `docs/` and `README.md`.
7. Run focused tests and typechecking throughout, then the full suite, build, package dry run, production audit, and diff checks once.
8. Run independent Standards and Spec reviews against `d4dde6b`, repair findings, revalidate, move this plan to `plans/done/`, and commit semantically with `Closes #39` as the first body line.

## Validation

- `node --test tests/agent-request.test.ts`
- `node --test tests/message-delivery.test.ts`
- `node --test tests/message-tool.test.ts`
- `node --test tests/message.test.ts`
- `node --test tests/agent-spawn.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm pack --dry-run`
- `npm audit --omit=dev`
- `git diff --check`

## Progress

- [x] Inspected issue #39 and its accepted design sources in issues #8, #12, #14, #22, and #30.
- [x] Reconfirmed the issue-level public TDD seams from the completed #37/#38 plans.
- [x] Protocol evidence and exact retention slice.
- [x] Request and Creation Request behavior slice.
- [x] Answer, retrieval, and release-handoff slice.
- [x] Cancellation and complete race-ordering slice.
- [x] Documentation, full validation, and independent review.

## Decisions

- Preserve #38's authored `deliveryMode` contract for Requests and same-identity retry; do not restore issue #14's older invocation-selected retry mode.
- Represent specialized protocol facts as Message kinds sharing one source identity and Delivery transport, while keeping Request-specific lookup and receipts explicit.
- Use exact Request identities for live retention multiplicity rather than category-only booleans.

## Surprises and discoveries

- The existing `answer_owed` behavior covered only Creation Request Delivery, and requester `awaiting_answer` was category-only. Exact Request-keyed relationships were required before Answer or Cancellation could safely release one of several concurrent waits.
- Initial review found that Answer and Cancellation lookup still relied on volatile maps. Transcript-derived Request resolution now owns durable lookup; in-memory entries bridge only the interval before Pi commits a native tool result.
- Accepted parent decisions require confirmation-loss outcomes for Request retry, Answer, and Cancellation even though issue #39 names only the higher-level behavior. Independent Spec review caught those missing `indeterminate` paths.

## Outcomes and retrospective

Issue #39 is complete. `agent_message` now implements immutable Request, first-Answer-wins Answer, native Answer Retrieval, exact Cancellation, Creation Request parity, and the required dormant/release race behavior without adding another durable state authority.

Protocol input validation, receipts, Request transcript resolution, and coordination evidence were split into focused modules during review repair. Request receipts expose the `requestId` alias, and passive Run status exposes retention categories with exact counts.

Independent Standards review found no hard violation after repair; independent Spec review passed with no remaining omission or scope creep. Final validation passed 65 tests plus typecheck, build, package dry run, production audit with zero vulnerabilities, and diff checks.
