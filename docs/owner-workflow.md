# Owner-only Workflow

Loading `pi-agent-coordination` in an interactive Pi TUI establishes the current Pi session as the Workflow Owner. No separate start command is required.

On first activation, the package appends one non-model-visible `agent-coordination.identity` entry. The Pi session identity is both the Agent identity and Workflow identity. Owner metadata is fixed to the label `owner`, and the entry records the immutable runtime baseline used for later coordination.

On later activation, the package validates the existing current-scope Owner Identity exactly. A session identified as a child Agent or Moderator is not reclassified.

## Coordination surface

- `agent_observe` returns the Owner's durable identity and current semantic Run state.
- `/agents` presents the Owner identity, live/ending phase, active/settled work state, and Owner host-binding retention.

These projections are read-only. Pi remains authoritative for the transcript, editor, history, queued input, tool rendering, and footer.

## Activation modes

Coordination activates only when Pi reports interactive TUI mode with UI support. Print, JSON, and RPC sessions register no coordination tool or command and create no coordinator.

## Host compatibility

Compatibility is determined by the running Pi host's integration shape. Before bootstrapping a Workflow, the package verifies the required runtime, interactive-mode, session, transcript, resource, extension, and disposal seams. A missing or malformed seam is reported by its canonical member name.

Pi's version is diagnostic information, not an allowlist. Package builds use a pinned Pi development cohort only to make conformance tests reproducible; installed Pi packages are runtime peers supplied by the host.

## Shutdown

Orderly Pi shutdown moves the Owner Run to `ending` immediately and passes disposal through one memoized native runtime path. Repeated or racing shutdown requests therefore dispose the Owner session exactly once. Abrupt process loss records no graceful-end claim.
