# pi-agent-coordination

Durable Pi agents that collaborate asynchronously under explicit Owner and Spawner supervision.

The package boots a Workflow in an interactive Pi TUI. It adopts the current session as the durable Workflow Owner, lets ordinary Agents create context-isolated durable children with `agent_spawn`, delivers immutable Deferred Messages through `agent_message`, exposes authorized status through `agent_observe` and `/agents`, preserves Pi's native interaction, and coordinates orderly shutdown.

```bash
npm install
npm run build
pi install .
pi
```

Print, JSON, and RPC modes do not activate coordination.

See [Owner Workflow](docs/owner-workflow.md) for activation and compatibility behavior, [Agent spawning](docs/agent-spawning.md) for child creation and receipt semantics, and [Agent messaging](docs/agent-messaging.md) for Deferred Delivery, polling, retry, and dormant Run restart.
