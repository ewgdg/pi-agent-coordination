# Workflow Policy

The Workflow Owner loads one optional user policy from Pi's agent configuration area:

```text
<getAgentDir()>/config/pi-agent-coordination.json
```

The file is a strict UTF-8 JSON object. Its complete optional surface is:

```json
{
  "maxConcurrentAgentRuns": 8,
  "maxPendingDeliveriesPerAgent": 256,
  "operationReviewIntervalMs": 600000
}
```

An omitted file or field uses the shown default. Unknown fields, duplicate keys, comments, trailing commas, wrong types, and invalid integers reject the complete file. Execution and delivery limits must be positive safe integers. `operationReviewIntervalMs` must be an integer from `1000` through `2147483647` milliseconds.

Invalid initial policy prevents coordination from creating the Workflow runtime. Owner resource reload reads the file again: a valid file atomically publishes one frozen complete snapshot, while an invalid file reports a diagnostic and preserves the previous snapshot. Reloading child resources does not reload Workflow Policy. Policy is volatile Owner-scoped configuration; it is not written to any Agent transcript or Agent Configuration.

## Ordinary execution

`maxConcurrentAgentRuns` limits ordinary Workflow Owner and child execution across the complete Workflow. A Run consumes one slot only while Pi is generating or executing its tools. A ready Run that cannot enter waits in Workflow-wide FIFO order before generation starts.

Queued, settled, held, input-required, ending, and dormant Runs consume no execution slot. Moderators are exempt. A reduced limit does not preempt active work: each ready execution keeps the complete policy snapshot captured at its admission and enters when current usage falls below that captured limit.

## Pending Message delivery

`maxPendingDeliveriesPerAgent` limits distinct pending Message identities separately for each recipient. Deferred and Steer scheduling share the limit. Same-identity retry coalesces without using another slot.

Each new distinct delivery admission uses the policy snapshot current at that admission. Lowering capacity never evicts admitted Messages. Exhaustion rejects only the new volatile scheduling request with `capacity_exhausted`; the canonical author Message remains available for later explicit retry. An exact-Hold Supervisory Resume Message keeps its separate reserved slot.

## Operation Review interval

`operationReviewIntervalMs` limits one applicable review interval for each unresolved root Pi tool call owned by an answer-obligated Agent. Each call captures the complete policy snapshot current at execution admission, so reload affects only later calls.

A blocking call starts its interval at execution admission. An asynchronous call starts an interval only when its Agent reaches an unattended Idle boundary. A Moderator may renew an exact current call for a positive interval no greater than the value captured by that call. Longer observation therefore requires another deliberate renewal; policy reload never stretches an admitted call's bound.
