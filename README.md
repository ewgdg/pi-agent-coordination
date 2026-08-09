# pi-agent-coordination

Durable Pi agents that collaborate asynchronously under explicit Owner and Spawner supervision.

## Features

- **Owner-directed Workflows:** the current interactive Pi session becomes the durable Workflow Owner. The Owner can fork or clone copied conversation into a fresh, independent Workflow.
- **Durable child Agents:** ordinary Agents can create context-isolated children with `agent_spawn`.
- **Messaging and Requests:** `agent_message` supports immutable Deferred and Steer Messages, correlated Requests and Answers, retrieval, and cancellation.
- **Human decisions for spawned Agents:** `ask_user_question` lets a spawned Agent block its exact Run on structured human input. Background requests appear as passive `DECIDE` attention.
- **Run supervision:** Workflow Owners and Direct Spawners can inspect authorized Agents with `agent_observe`, then interrupt, explicitly resume, or terminate exact Runs with `agent_control`.
- **Operational incident handling:** isolated Moderators handle overdue answer obligations, Obligation Stalls, answer-obligated Run Failures, and closed live Dependency Deadlocks. Review renewal, Run control, Owner escalation, and Resolution are policy-bounded and mechanically gated.
- **Durable recovery:** a fresh host reconstructs verified authority, standalone Moderators, and residual Request retention from complete Pi transcripts without replaying volatile work.
- **Interactive Agent views:** `/agents` presents attention plus live and dormant Agents, then attaches the selected Agent's complete Pi transcript, editor, footer, commands, and extension UI without rebinding the Owner runtime.

Coordinated model generations never use generic regenerated-prompt retry. Only adapter-proven continuation of the same generation is eligible. One failed Moderator may be replaced once; a second failure creates passive, Owner-only Operational Attention.

## Installation

Install directly from the Git repository:

```bash
pi install git:github.com/ewgdg/pi-agent-coordination
```

## Usage

Start an interactive Pi TUI:

```bash
pi
```

The package adopts the current session as the Workflow Owner; no separate activation command is required. Print, JSON, and RPC modes do not activate coordination.

## Compatibility

Pi supplies the package's Pi peer modules. Compatibility is defined jointly by a fail-fast structural gate against the running host module world and the native behavioral conformance suite. The Pi version is diagnostic only.

Maintainers can run the focused compatibility gate with:

```bash
npm run test:conformance
```

`npm test` remains the complete regression suite.

## Trust and persistence

Coordination is a trust-based protocol, not a security boundary. Owners, Spawners, ordinary Agents, and Moderators are trusted participants acting through role-scoped tools.

Pi transcripts are the durable authority for identity, Messages, Requests, Deliveries, and committed results. Scheduling queues, Holds, live Run state, UI attention, and open Agent-view attachment are volatile: orderly shutdown closes them, while abrupt process loss can discard them without claiming durable completion.

## Documentation

- [Owner Workflow](docs/owner-workflow.md) — activation and compatibility behavior
- [Operational Incident moderation](docs/operational-incident-moderation.md) — trigger detection, bounded handling, Moderator authority, Resolution, and recovery
- [Cold host recovery](docs/cold-host-recovery.md) — transcript discovery, quarantine, dormant rosters, and residual Requests
- [Workflow Policy](docs/workflow-policy.md) — reloadable execution, delivery, and review limits
- [Agent spawning](docs/agent-spawning.md) — child creation and receipt semantics
- [Agent messaging](docs/agent-messaging.md) — delivery modes and Agent Requests
- [Human Requests](docs/human-requests.md) — structured Questions and native interaction
- [Agent selector](docs/agent-selector.md) — Live hierarchy, Dormant recency, attention, and keyboard navigation
- [Interactive Agent view acceptance](docs/agent-view-acceptance.md) — complete-mode rendering, input, transitions, isolation, and lifecycle evidence
- [Run supervision](docs/run-supervision.md) — observation, interruption, resumption, termination, and Agent-view retention
