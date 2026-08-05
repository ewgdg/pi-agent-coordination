# Operational Incident moderation

The host starts an isolated Moderator when live coordination evidence matches an Obligation Stall, Run Failure, or Dependency Deadlock. Operational Incidents are transient observations of blocked obligated work, not durable Agent or Workflow lifecycle states.

## Detection

An Obligation Stall exists while an ordinary Agent Run is live, settled, still owes an Answer, and has no admitted input, pending Delivery, Human attention, interactive selection, Interruption Hold, or outgoing Request path that can make progress.

A Run Failure exists after one exact non-Moderator Run, including a Workflow Owner Run, ends unexpectedly and the Agent still has an unresolved Answer Obligation. Provider retry events do not trigger handling before terminal retry exhaustion. The condition clears when every qualifying obligation ends or a successor Run successfully starts; a successor that later settles without progress is evaluated independently as an Obligation Stall.

A Dependency Deadlock is a normalized closed component of current ordinary Runs. Every member must be live, settled, retained solely by unresolved Request relationships internal to the component, free of required attention and Holds, and have no other progress source. Self-cycles are valid components. Any incoming or outgoing external Request edge, active or starting Run, admitted input, selection, Human attention, Hold, failed Run, or non-Request retention prevents declaration.

Deadlock detection is observational. It does not cancel a Request, interrupt or terminate a Run, control descendants, or grant authority.

Clean Run release, deliberate termination, orderly shutdown, optional work, ordinary model duration, Human waiting, and intentional Holds do not create Run Failure or Dependency Deadlock handling.

## Continuous conditions

Each trigger has a deterministic transient Handling Key:

- Obligation Stall uses the affected Agent and sorted qualifying Request identities.
- Run Failure uses the affected Agent and exact Run sequence.
- Dependency Deadlock uses sorted component Agent and Request identities.

The key suppresses duplicates only while that exact continuous predicate remains true. Relevant Run, Request, Delivery, input, selection, attention, and Hold transitions revalidate all current conditions. Clearing a predicate releases its key and the current Moderator's `moderator_handling` retention without aborting the Moderator or settling its ordinary Requests.

## Atomic Moderator bootstrap

Before starting a Moderator Run, the host commits one visible `agent-coordination.moderator-input` as the first transcript entry. It contains:

- the fresh Agent and Workflow relationship;
- fixed `moderator` metadata and the Owner-derived runtime baseline;
- one trigger snapshot;
- up to 16 exact qualifying Request sources;
- inspection watermarks for every affected Agent;
- for a replacement, the previous attempt's terminal transcript pointer.

Failure before this commit creates no Agent and consumes no attempt. A committed Input creates a standalone Moderator with no Direct Spawner, even if startup or its Run then fails.

## Bounded handling failure

One continuous condition permits at most two committed automatic attempts: the initial Moderator and one fresh replacement. A post-commit startup failure or terminal Moderator Run failure consumes its attempt. The replacement continues the original condition and points to the first attempt's terminal evidence; Moderator failure never becomes a nested Operational Incident.

After the second committed attempt fails, automatic creation stops. Passive Operational Attention appears in the native status/widget surface and as an `ATTENTION` row in `/agents`. It presents the original trigger—including its exact Run sequence when applicable and bounded Request source pointers—the affected Agent identities, and the two terminal diagnostic pointers. Only the Workflow Owner can observe this attention. It disappears immediately when the original predicate clears.

## Diagnosis, escalation, and Resolution

A Moderator can inspect any known Workflow Agent and control any current non-Owner Run, but cannot control the Owner or itself and never receives `agent_spawn`. Every Message, Request, Human Request, observation, and control operation remains authenticated as the Moderator's own identity.

Task intent, priority, value, policy, risk, irreversible effects, and requested Owner action use an ordinary Agent Request to the Workflow Owner.

`moderator_control` records the handling summary and rationale. Resolution is blocked while the Moderator has an incoming or outgoing Request relationship or its mechanically checkable original condition remains. Once clear, it reports `resolved` when an original obligation still exists behind a credible progress source, or `already_cleared` when the original obligations ended.

## Cold recovery

Cold discovery validates committed Moderator Inputs and admits valid Moderators as standalone dormant Agents. Recovered Moderators remain routable and restart with the Moderator toolset.

Recovery reconstructs no live condition, Handling Key, attempt chain, previous Run, exhausted Operational Attention, scheduling, or Moderator reuse. Current live evidence after recovery must establish a fresh condition.
