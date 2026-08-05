# pi-agent-coordination

Durable Pi agents that collaborate asynchronously under explicit Owner and Spawner supervision.

The package boots a Workflow in an interactive Pi TUI. It adopts the current session as the durable Workflow Owner, lets the Owner fork or clone copied conversation into a fresh independent Workflow, lets ordinary Agents create context-isolated durable children with `agent_spawn`, and provides immutable Deferred or Steer Messages plus correlated Request, Answer, retrieval, and cancellation through `agent_message`. Any Agent can block its exact Run on structured human input through `ask_user_question`; background requests appear as passive `DECIDE` attention. Workflow Owners and Direct Spawners can inspect authorized Agents with `agent_observe` and interrupt, explicitly resume, or terminate exact Runs with `agent_control`. Overdue answer-obligated root tool calls, Obligation Stalls, answer-obligated Run Failures, and closed live Dependency Deadlocks receive isolated Moderator handling with workflow-wide inspection, policy-bounded review renewal, non-Owner Run control, ordinary Owner escalation, and mechanically gated Resolution. Coordinated model generations never use generic regenerated-prompt retry; only adapter-proven same-generation continuation is eligible. One failed Moderator may be replaced once; a second failure creates passive Owner-only Operational Attention. `/agents` presents attention plus live and dormant Agents while preserving native interaction for retained sessions. A fresh host rediscovers verified ordinary authority, standalone Moderators, and residual Request retention from complete Pi transcripts without replaying volatile work. A reloadable Workflow Policy applies fair ordinary execution, per-recipient delivery limits, and captured Operation Review intervals. The package preserves Pi's transcript authority and coordinates orderly shutdown.

```bash
npm install
npm run build
pi install .
pi
```

Print, JSON, and RPC modes do not activate coordination.

See [Owner Workflow](docs/owner-workflow.md) for activation and compatibility behavior, [Operational Incident moderation](docs/operational-incident-moderation.md) for trigger detection, bounded handling, Moderator authority, Resolution, and recovery, [Cold host recovery](docs/cold-host-recovery.md) for transcript discovery, quarantine, dormant rosters, and residual Requests, [Workflow Policy](docs/workflow-policy.md) for reloadable execution, delivery, and review limits, [Agent spawning](docs/agent-spawning.md) for child creation and receipt semantics, [Agent messaging](docs/agent-messaging.md) for delivery modes and Agent Requests, [Human Requests](docs/human-requests.md) for structured Questions and native interaction, and [Run supervision](docs/run-supervision.md) for observation, interruption, resumption, termination, and session selection.
