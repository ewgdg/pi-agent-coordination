# Owner Workflow

Loading `pi-agent-coordination` in an interactive Pi TUI establishes the current Pi session as the Workflow Owner. No separate start command is required.

Before creating the coordination runtime, bootstrap loads and validates the optional user [Workflow Policy](workflow-policy.md). Invalid initial policy prevents runtime creation without appending Owner Identity.

On first activation, the package appends one non-model-visible `agent-coordination.identity` entry. The Pi session identity is both the Agent identity and Workflow identity. Owner metadata is fixed to the label `owner`, and the entry records the immutable runtime baseline used for later coordination.

On later activation, the package validates the existing current-scope Owner Identity exactly. A session identified as a child Agent or Moderator is not reclassified.

## Owner fork and clone

Pi's native fork and clone operations are available only while the current interactive session is the admitted Workflow Owner. An ordinary child or Moderator attempt is cancelled before Pi prepares a replacement session.

A successful Owner fork receives a fresh Pi session identity and appends one fresh fixed Owner Identity. That entry is the coordination-evidence cutoff for the new Workflow. Pi's copied conversation remains native model and history context, but earlier Agent Identities, Messages, Requests, Deliveries, and authority are outside the new current scope.

The new Owner identity also selects a new Workflow transcript directory. The fork therefore begins with no ordinary children or Moderators from the source Workflow. Source identities and Request identities cannot be observed, controlled, polled, retried, Answered, or cancelled from the fork. New children created in the fork belong only to the new Workflow.

Fork replacement ends the source Workflow's transient hosted Runs without changing its transcripts. Reopening the source Owner reconstructs its verified source Workflow normally. A copied child or Moderator transcript prepared outside Pi's cancellable live fork path is not admitted as a Workflow Owner; participant admission still requires a matching bootstrap for its own Pi session identity.

## Coordination surface

After Owner Identity validation, the package binds the ordinary tools through a hidden extension closed over that Agent identity. Caller identity and role configuration are never model-supplied tool arguments.

- `agent_spawn` creates one fresh configured child, optionally resolving a named Agent Template, and delivers its initial Creation Request.
- `agent_message` sends Messages, creates correlated Requests, Answers, retrieves, and cancels.
- `ask_user_question` blocks the caller's exact Run on one or more structured Questions. Its matching successful native tool result is the sole Human Answer.
- `agent_observe` returns an authorized Agent's durable identity, structural relationship, bounded primary transcript evidence, current semantic Run state, or direct children. Live retention reasons include a count so concurrent exact Request relationships remain visible without exposing payloads.
- `agent_control` interrupts, explicitly resumes, or terminates one authorized exact child Run.
- `/agents` presents numbered `DECIDE` Human Request rows, passive Owner-only `ATTENTION` rows for exhausted Operational Incident handling, and Workflow Agent statuses. Selecting a live Agent switches the native editor and transcript view to that retained session; selecting a `DECIDE` row opens that exact Human Request without background focus theft.

These projections are read-only. Pi remains authoritative for the transcript, editor, history, queued input, tool rendering, and footer.

See [Human Requests](human-requests.md) for the Question and Answer shapes, interaction keys, commitment boundary, and Run fencing behavior. See [Run supervision](run-supervision.md) for authority, status, exact Holds, isolated resumption, termination, and `/agents` selection.

## Activation modes

Coordination activates only when Pi reports interactive TUI mode with UI support. Print, JSON, and RPC sessions register no coordination tool or command and create no coordinator.

## Host compatibility

Compatibility is determined by the running Pi host's integration shape. Before bootstrapping a Workflow, the package verifies the required runtime, interactive-mode, session, transcript, resource, extension, and disposal seams. A missing or malformed seam is reported by its canonical member name.

Pi's version is diagnostic information, not an allowlist. Package builds use a pinned Pi development cohort only to make conformance tests reproducible; installed Pi packages are runtime peers supplied by the host.

## Shutdown

Orderly Pi shutdown fences new spawn admission, restores native selection to the Owner, ends retained child Runs, moves the Owner Run to `ending`, and passes Owner disposal through one memoized native runtime path. Repeated or racing shutdown requests therefore dispose the Owner session exactly once. Abrupt process loss records no graceful-end claim.
