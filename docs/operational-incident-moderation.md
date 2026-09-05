# Operational Incident moderation

The host starts an isolated Moderator when live coordination evidence matches an Operation Review, Obligation Stall, Run Failure, Dependency Deadlock, or Delivery Stall. Operational Incidents are transient observations of blocked obligated work, not durable Agent or Workflow lifecycle states.

## Detection

Host state changes share one pending reconciliation. Each scheduled pass yields to native events before inspecting current evidence; changes during that inspection schedule a fresh successor pass. A safe-boundary wait includes passes queued before the wait. Creation Request lookup follows the child's Identity to its Spawner's committed source without scanning unrelated Agent histories.

An Obligation Stall exists while an ordinary Agent Run is live, settled, still owes an Answer, and has no admitted input, pending Delivery, Human attention, interactive selection, Interruption Hold, or outgoing Request path that can make progress. Before creating a Moderator for a simple Stall, the host delivers one model-visible `agent-coordination.obligation-reminder` for the exact Request. The reminder contains the Request identity, a whitespace-normalized snippet of at most 160 code points, and direct Answer guidance; it never repeats a longer Request body.

Reminder suppression is per durable Request identity. A successor Run or a later recurrence with the same unresolved obligation does not receive another reminder. The reminder uses ordinary Deferred custom Delivery scheduling and supplies its own model turn. If the Agent settles again without discharging that obligation, the host creates the Obligation Stall Moderator. A closed Dependency Deadlock is handled as one normalized condition instead of also reminding or independently moderating its member Stalls.

An Operation Review exists when an independently watched root Pi tool call reaches its review deadline while still unresolved and its Agent still owes an Answer. A Pi tool batch is effectively blocking when any call in the committed batch declares sequential execution; otherwise its calls are asynchronous. Blocking review begins at execution admission. Asynchronous review covers only a continuous unattended Idle interval and ends when Agent work resumes before expiry. Each call uses the Workflow Policy interval captured at admission.

Human Request setup is reviewed from execution admission until Human waiting begins. Human waiting is excluded. Human Answer arrival starts a fresh result-commit interval until the terminal tool result commits. Progress, logs, heartbeat, partial output, and internal awaits do not affect review. Expiry establishes only the need for review: it does not abort, retry, interrupt, terminate, or declare the tool's outcome.

Resumed attendance ends an asynchronous interval only before its deadline; once that interval expires, later attendance alone does not clear the review. Before Moderator Input commits, terminal tool-result commit, final Answer Obligation clearance, or Human waiting still suppresses the condition. After Moderator Input commits, Human waiting also cannot clear it; the tool must resolve, the final qualifying obligation must end, or a Moderator must renew the interval.

A Run Failure exists after one exact non-Moderator Run, including a Workflow Owner Run, ends unexpectedly after Pi's user-configured native recovery behavior has finished and the Agent still has an unresolved Answer Obligation. The condition clears when every qualifying obligation ends or a successor Run successfully starts. When a successor starts, the host delivers a visible `agent-coordination.run-failure-recovery` to the handling Moderator at its next settled boundary, directing immediate Resolution; the remaining Answer Obligation is ordinary Workflow work. A successor that later settles without progress is evaluated independently as an Obligation Stall.

A Dependency Deadlock is a normalized closed component of current ordinary Runs. Every member must be live, settled, retained solely by unresolved Request relationships internal to the component, free of required attention and Holds, and have no other progress source. Self-cycles are valid components. Any incoming or outgoing external Request edge, active or starting Run, admitted input, selection, Human attention, Hold, failed Run, or non-Request retention prevents declaration.

Deadlock detection is observational. It does not cancel a Request, interrupt or terminate a Run, control descendants, or grant authority.

Clean Run release, deliberate termination, orderly shutdown, optional work, ordinary model duration, Human waiting, and intentional Holds do not create Run Failure or Dependency Deadlock handling. Operation Review never times model generation or internal coordination machinery, including a parked `agent_wait`; the existing Request graph remains eligible for Dependency Deadlock observation. Primary interactive human input or an eligible inbound Agent Request preempts the parked Wait through normal coordination, so human redirection and reverse-Request flows do not depend on Dependency Deadlock moderation.

## Delivery Stall

A Delivery Stall is observed when an unresolved Answer Obligation depends on a Message whose delivery machinery has lost its continuation or exhausted its progress interval. The dependency is traced through outstanding Requests from an obligated ordinary Agent, including a parent parked in `agent_wait`. The undelivered recipient need not owe an Answer yet, and the path need not form a cycle. Pending retention alone is not evidence of progress.

Delivery progress uses the admission-time `deliveryProgressIntervalMs` from [Workflow Policy](workflow-policy.md):

| Transition or observation | Deadline effect |
| --- | --- |
| First observation of eligible pending scheduling | Start the captured interval |
| Frozen scheduling reservation, then dispatch to Pi | Reset at each meaningful transition |
| Transcript Delivery proof or Request suppression | Clear observation and handling |
| Execution-capacity wait, active recipient work before dispatch, or admission behind an existing Answer Obligation | Suspend; follow outstanding Request dependencies rather than timing the wait |
| Human attention, interactive selection, or intentional Hold on the recipient | Suspend; regain eligibility with a fresh interval |
| Poll, heartbeat, repeated state observation, or policy reload | No extension |
| Scheduling/dispatch exception with no continuing delivery path, including startup/admission exits before dispatch | Immediately request investigation once a qualifying obligation path exists |

A dispatch Promise can cover the entire Pi model turn. It is not Delivery proof, and waiting for its completion must not time model generation: transcript commitment ends delivery observation independently of that Promise.

Human waiting, selection, and Holds anywhere along a qualifying path exclude that path. Active or starting intermediate Agents remain legitimate progress sources. An obligated parent doing ordinary model work does not qualify just because a child delivery is pending. Run termination does not cancel Requests or exempt stranded delivery work: an unproven Delivery losing its recipient Run remains observable as a known scheduling failure while an upstream obligation still qualifies. This does not restart the recipient or turn deliberate termination into Run Failure handling.

One continuous blocked Message produces one handling instance containing affected Agent identities, bounded canonical Request source pointers along the dependency, the exact Message and recipient identities, and either the observed scheduling diagnostic or the expired stage and interval. Other triggers retain their contracts; affected Delivery Stall paths do not also receive simple Obligation Stall reminders. The condition ends when proof, suppression, meaningful progress, a legitimate wait/exclusion, or final qualifying obligation clearance removes the blockage. Later recurrence is independently handled.

Detection does **not** establish a delivery outcome, retry a Message, recreate scheduling, cancel Requests, duplicate Delivery proof, or authorize new Moderator operations. Existing explicit Message Retry semantics remain unchanged.

## Continuous conditions

Each trigger has a deterministic transient Handling Key:

- Obligation Stall uses the affected Agent and sorted qualifying Request identities after any required reminder has been delivered.
- Run Failure uses the affected Agent and exact Run sequence.
- Dependency Deadlock uses sorted component Agent and Request identities.
- Operation Review uses the exact root tool-call pointer.
- Delivery Stall uses the blocked Message identity, aggregating current qualifying upstream paths.

The key suppresses duplicates only while that exact continuous predicate remains true. Relevant Run, Request, Delivery, input, selection, attention, and Hold transitions revalidate all current conditions. Clearing a predicate releases its key and the current Moderator's `moderator_handling` retention without aborting the Moderator or settling its ordinary Requests.

## Atomic Moderator bootstrap

Before starting a Moderator Run, the host commits one visible `agent-coordination.moderator-input` as the first transcript entry. It contains:

- the fresh Agent and Workflow relationship;
- fixed `moderator` metadata;
- one trigger snapshot;
- up to 16 exact qualifying Request sources;
- inspection watermarks for every affected Agent;
- for a replacement, the previous attempt's terminal transcript pointer.

Failure before this commit creates no Agent and consumes no attempt. A committed Input creates a standalone Moderator with no Direct Spawner, even if startup or its Run then fails. After Runtime admission, the host sends a hidden `agent-coordination.moderator-routine-start` message through ordinary public delivery to start the model turn; the durable identity and incident remain together in the preceding Input. Each new Moderator Runtime dynamically resolves the current Owner Runtime, current reserved `moderator` Template, resources, trust, native project-context inheritance, and explicit system prompt. Without a Template model selection, it inherits the Owner model but lets Pi apply the shared default thinking level instead of inheriting the Owner's effective level. Those resolved values are not part of Moderator Input.

An Operation Review trigger contains only `kind`, the exact `toolCall` pointer, and the elapsed `reviewIntervalMs`. It carries no inferred outcome, internal-stage details, deadline timestamp, adapter state, or eager diagnostics.

## Bounded handling failure

One continuous condition permits at most two committed automatic attempts: the initial Moderator and one fresh replacement. A post-commit startup failure or terminal Moderator Run failure consumes its attempt. The replacement continues the original condition and points to the first attempt's terminal evidence; Moderator failure never becomes a nested Operational Incident.

After the second committed attempt fails, automatic creation stops. Passive Operational Attention appears once in the Owner-scoped activity dock and as an `ATTENTION` row in `/agents`. It presents the original trigger—including its exact Run sequence when applicable and bounded Request source pointers—the affected Agent identities, and the two terminal diagnostic pointers. Selecting attention for exactly one affected Agent opens that Agent's view without changing the incident; multi-Agent attention remains informational and Enter keeps `/agents` open. Only the Workflow Owner can observe this attention. It disappears immediately when the original predicate clears.

## Unavailable moderation and Owner attention

The moderation reconciliation boundary contains evidence-inspection and Moderator-creation failures. It retains one non-model-visible `agent-coordination.operational-diagnostic` entry in the Owner transcript with the error message and full stack, and presents one concise passive Owner attention item with its diagnostic pointer. Creation failure preserves the original trigger and affected Agents; inspection failure reports `moderation_unavailable` without inventing a Request graph. The latter is an attention signal, not a Moderator trigger or durable failure state.

A watchdog uses the current delivery-progress policy interval to surface the same attention if the inspection/bootstrap pass is still blocked. Both initial Moderator creation and replacement preparation after a terminal Moderator failure run within this timed containment; immediate replacements share their enclosing pass. It does not abort the Promise, unlock a lane, retry scheduling, or infer whether effects committed. Repeated activity does not duplicate attention or diagnostic entries for the continuous fault. A creation exception retains faulted handling and stops further staging for that continuous condition, including failure before the first Moderator Input commits. Heartbeats, safe-boundary checks and unrelated activity do not retry preparation. Condition clearance releases the faulted handling; a later recurrence starts fresh. A preparation that only exceeded its deadline may still finish, without cancellation or another attempt. A successful inspection clears inspection attention; successful creation or original-condition clearance clears creation attention. Failure before Moderator Input commits consumes no committed attempt, but is not permission for repeated staging; committed handling keeps the existing two-attempt bound.

This is the scoped containment required for delivery-blockage detection. It does not decide the broader participant lifecycle containment, fencing, or cleanup policy discussed in issue #75. Core evidence scanners continue throwing; no malformed-call race or scheduler-recovery behavior is changed. Passive attention belongs to the Owner surface, including when a child Runtime supplies the selected view; it is not a generic Pi extension-error chat row.

## Diagnosis, escalation, and Resolution

A Moderator can inspect any known Workflow Agent and control any current non-Owner Run, but cannot control the Owner or itself and never receives `agent_spawn`. Every Message, Request, Human Request, observation, and control operation remains authenticated as the Moderator's own identity.

Task intent, priority, value, policy, risk, irreversible effects, and requested Owner action use an ordinary Agent Request to the Workflow Owner.

`moderator_control` can renew any current reviewed call in the same Workflow. `renew_review_deadline` selects the exact tool-call pointer, a positive `nextReviewInMs` no greater than the call's captured policy interval, and a rationale. The host revalidates the source, terminal result, and Answer Obligation before returning `renewed`; an expected completion race returns `stale`. Renewal starts only that call's selected interval immediately. Because renewal deliberately replaces an established condition, later attendance does not cancel that selected interval. Renewal never inspects, restarts, retries, interrupts, or otherwise changes the tool or Run.

`moderator_control` also records the handling summary and rationale. Resolution is blocked while the Moderator has an incoming or outgoing Request relationship or its mechanically checkable original condition remains. A Run Failure Moderator resolves immediately after its successor-start recovery notice and does not wait for the original Answer Obligation or adopt later Requests. Once clear, Resolution reports `resolved` when an original obligation still exists behind a credible progress source, or `already_cleared` when the original obligations ended.

## Cold recovery

Cold discovery validates committed Moderator Inputs and admits valid Moderators as standalone dormant Agents. Recovered Moderators remain routable and restart with the Moderator toolset.

Recovery reconstructs no timer, review interval, attendance, live condition, Handling Key, attempt chain, previous Run, exhausted Operational Attention, scheduling, or Moderator reuse. Current live evidence after recovery must establish a fresh condition.
