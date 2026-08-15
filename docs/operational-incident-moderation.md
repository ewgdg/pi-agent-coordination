# Operational Incident moderation

The host starts an isolated Moderator when live coordination evidence matches an Operation Review, Obligation Stall, Run Failure, or Dependency Deadlock. Operational Incidents are transient observations of blocked obligated work, not durable Agent or Workflow lifecycle states.

## Detection

An Obligation Stall exists while an ordinary Agent Run is live, settled, still owes an Answer, and has no admitted input, pending Delivery, Human attention, interactive selection, Interruption Hold, or outgoing Request path that can make progress. Before creating a Moderator for a simple Stall, the host delivers one model-visible `agent-coordination.obligation-reminder` for the exact Request. The reminder contains the Request identity, a whitespace-normalized snippet of at most 160 code points, and direct Answer guidance; it never repeats a longer Request body.

Reminder suppression is per durable Request identity. A successor Run or a later recurrence with the same unresolved obligation does not receive another reminder. The reminder uses ordinary Deferred custom Delivery scheduling and supplies its own model turn. If the Agent settles again without discharging that obligation, the host creates the Obligation Stall Moderator. A closed Dependency Deadlock is handled as one normalized condition instead of also reminding or independently moderating its member Stalls.

An Operation Review exists when an independently watched root Pi tool call reaches its review deadline while still unresolved and its Agent still owes an Answer. A Pi tool batch is effectively blocking when any call in the committed batch declares sequential execution; otherwise its calls are asynchronous. Blocking review begins at execution admission. Asynchronous review covers only a continuous unattended Idle interval and ends when Agent work resumes before expiry. Each call uses the Workflow Policy interval captured at admission.

Human Request setup is reviewed from execution admission until Human waiting begins. Human waiting is excluded. Human Answer arrival starts a fresh result-commit interval until the terminal tool result commits. Progress, logs, heartbeat, partial output, and internal awaits do not affect review. Expiry establishes only the need for review: it does not abort, retry, interrupt, terminate, or declare the tool's outcome.

Resumed attendance ends an asynchronous interval only before its deadline; once that interval expires, later attendance alone does not clear the review. Before Moderator Input commits, terminal tool-result commit, final Answer Obligation clearance, or Human waiting still suppresses the condition. After Moderator Input commits, Human waiting also cannot clear it; the tool must resolve, the final qualifying obligation must end, or a Moderator must renew the interval.

A Run Failure exists after one exact non-Moderator Run, including a Workflow Owner Run, ends unexpectedly after Pi's user-configured native recovery behavior has finished and the Agent still has an unresolved Answer Obligation. The condition clears when every qualifying obligation ends or a successor Run successfully starts. When a successor starts, the host delivers a visible `agent-coordination.run-failure-recovery` to the handling Moderator at its next settled boundary, directing immediate Resolution; the remaining Answer Obligation is ordinary Workflow work. A successor that later settles without progress is evaluated independently as an Obligation Stall.

A Dependency Deadlock is a normalized closed component of current ordinary Runs. Every member must be live, settled, retained solely by unresolved Request relationships internal to the component, free of required attention and Holds, and have no other progress source. Self-cycles are valid components. Any incoming or outgoing external Request edge, active or starting Run, admitted input, selection, Human attention, Hold, failed Run, or non-Request retention prevents declaration.

Deadlock detection is observational. It does not cancel a Request, interrupt or terminate a Run, control descendants, or grant authority.

Clean Run release, deliberate termination, orderly shutdown, optional work, ordinary model duration, Human waiting, and intentional Holds do not create Run Failure or Dependency Deadlock handling. Operation Review never times model generation or internal coordination machinery, including a parked `agent_wait`; the existing Request graph remains eligible for Dependency Deadlock observation.

## Continuous conditions

Each trigger has a deterministic transient Handling Key:

- Obligation Stall uses the affected Agent and sorted qualifying Request identities after any required reminder has been delivered.
- Run Failure uses the affected Agent and exact Run sequence.
- Dependency Deadlock uses sorted component Agent and Request identities.
- Operation Review uses the exact root tool-call pointer.

The key suppresses duplicates only while that exact continuous predicate remains true. Relevant Run, Request, Delivery, input, selection, attention, and Hold transitions revalidate all current conditions. Clearing a predicate releases its key and the current Moderator's `moderator_handling` retention without aborting the Moderator or settling its ordinary Requests.

## Atomic Moderator bootstrap

Before starting a Moderator Run, the host commits one visible `agent-coordination.moderator-input` as the first transcript entry. It contains:

- the fresh Agent and Workflow relationship;
- fixed `moderator` metadata;
- one trigger snapshot;
- up to 16 exact qualifying Request sources;
- inspection watermarks for every affected Agent;
- for a replacement, the previous attempt's terminal transcript pointer.

Failure before this commit creates no Agent and consumes no attempt. A committed Input creates a standalone Moderator with no Direct Spawner, even if startup or its Run then fails. After Runtime admission, the host sends a hidden `agent-coordination.moderator-routine-start` message through ordinary public delivery to start the model turn; the durable identity and incident remain together in the preceding Input. Each new Moderator Runtime dynamically resolves the current Owner Runtime, current reserved `moderator` Template, resources, trust, and Project Context; those resolved values are not part of Moderator Input.

An Operation Review trigger contains only `kind`, the exact `toolCall` pointer, and the elapsed `reviewIntervalMs`. It carries no inferred outcome, internal-stage details, deadline timestamp, adapter state, or eager diagnostics.

## Bounded handling failure

One continuous condition permits at most two committed automatic attempts: the initial Moderator and one fresh replacement. A post-commit startup failure or terminal Moderator Run failure consumes its attempt. The replacement continues the original condition and points to the first attempt's terminal evidence; Moderator failure never becomes a nested Operational Incident.

After the second committed attempt fails, automatic creation stops. Passive Operational Attention appears once in the Owner-scoped activity dock and as an `ATTENTION` row in `/agents`. It presents the original trigger—including its exact Run sequence when applicable and bounded Request source pointers—the affected Agent identities, and the two terminal diagnostic pointers. Selecting attention for exactly one affected Agent opens that Agent's view without changing the incident; multi-Agent attention remains informational and Enter keeps `/agents` open. Only the Workflow Owner can observe this attention. It disappears immediately when the original predicate clears.

## Diagnosis, escalation, and Resolution

A Moderator can inspect any known Workflow Agent and control any current non-Owner Run, but cannot control the Owner or itself and never receives `agent_spawn`. Every Message, Request, Human Request, observation, and control operation remains authenticated as the Moderator's own identity.

Task intent, priority, value, policy, risk, irreversible effects, and requested Owner action use an ordinary Agent Request to the Workflow Owner.

`moderator_control` can renew any current reviewed call in the same Workflow. `renew_review_deadline` selects the exact tool-call pointer, a positive `nextReviewInMs` no greater than the call's captured policy interval, and a rationale. The host revalidates the source, terminal result, and Answer Obligation before returning `renewed`; an expected completion race returns `stale`. Renewal starts only that call's selected interval immediately. Because renewal deliberately replaces an established condition, later attendance does not cancel that selected interval. Renewal never inspects, restarts, retries, interrupts, or otherwise changes the tool or Run.

`moderator_control` also records the handling summary and rationale. Resolution is blocked while the Moderator has an incoming or outgoing Request relationship or its mechanically checkable original condition remains. A Run Failure Moderator resolves immediately after its successor-start recovery notice and does not wait for the original Answer Obligation or adopt later Requests. Once clear, Resolution reports `resolved` when an original obligation still exists behind a credible progress source, or `already_cleared` when the original obligations ended.

## Cold recovery

Cold discovery validates committed Moderator Inputs and admits valid Moderators as standalone dormant Agents. Recovered Moderators remain routable and restart with the Moderator toolset.

Recovery reconstructs no timer, review interval, attendance, live condition, Handling Key, attempt chain, previous Run, exhausted Operational Attention, scheduling, or Moderator reuse. Current live evidence after recovery must establish a fresh condition.
