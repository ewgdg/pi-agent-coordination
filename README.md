# pi-agent-coordination

Durable Pi agents that collaborate asynchronously under explicit Owner and Spawner supervision.

The package boots a Workflow in an interactive Pi TUI. It adopts the current session as the durable Workflow Owner, lets ordinary Agents create context-isolated durable children with `agent_spawn`, and provides immutable Deferred or Steer Messages plus correlated Request, Answer, retrieval, and cancellation through `agent_message`. Any Agent can block its exact Run on structured human input through `ask_user_question`; background requests appear as passive `DECIDE` attention. The package exposes authorized status through `agent_observe` and `/agents`, preserves Pi's native interaction, and coordinates orderly shutdown.

```bash
npm install
npm run build
pi install .
pi
```

Print, JSON, and RPC modes do not activate coordination.

See [Owner Workflow](docs/owner-workflow.md) for activation and compatibility behavior, [Agent spawning](docs/agent-spawning.md) for child creation and receipt semantics, [Agent messaging](docs/agent-messaging.md) for delivery modes and Agent Requests, and [Human Requests](docs/human-requests.md) for structured Questions, native interaction, commitment, and interruption.
