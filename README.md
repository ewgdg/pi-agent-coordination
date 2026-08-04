# pi-agent-coordination

Durable Pi agents that collaborate asynchronously under explicit Owner and Spawner supervision.

The current package boots an Owner-only Workflow in an interactive Pi TUI. It adopts the current session as the durable Workflow Owner, preserves Pi's native interaction, exposes Owner status through `agent_observe` and `/agents`, and coordinates orderly shutdown.

```bash
npm install
npm run build
pi install .
pi
```

Print, JSON, and RPC modes do not activate coordination.

See [Owner-only Workflow](docs/owner-workflow.md) for the runtime contract and compatibility behavior.
