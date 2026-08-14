# Owner Workflow

Loading `pi-agent-coordination` in an interactive Pi TUI establishes the current Pi session as the Workflow Owner. No separate start command is required. Coordination associates Pi's public Runtime registration and TUI session binding with the current `SessionManager`, then borrows that native Runtime without taking disposal authority.

Before creating the coordination runtime, bootstrap loads and validates the optional user [Workflow Policy](workflow-policy.md). Invalid initial policy prevents runtime creation without appending Owner Identity.

On first activation, the package appends one non-model-visible `agent-coordination.identity` entry. The Pi session identity is both the Agent identity and Workflow identity, and Owner metadata is fixed to the label `owner`. Resolved Owner Runtime configuration and resources are not copied into Identity.

On later activation, the package validates the existing current-scope Owner Identity exactly. A session identified as a child Agent or Moderator is not reclassified.

## Owner fork and clone

Pi's native fork and clone operations are available only while the current interactive session is the admitted Workflow Owner. An ordinary child or Moderator attempt is cancelled before Pi prepares a replacement session.

A successful Owner fork receives a fresh Pi session identity and appends one fresh fixed Owner Identity. That entry is the coordination-evidence cutoff for the new Workflow. Pi's copied conversation remains native model and history context, but earlier Agent Identities, Messages, Requests, Deliveries, and authority are outside the new current scope.

The new Owner identity also selects a new Workflow transcript directory. The fork therefore begins with no ordinary children or Moderators from the source Workflow. Source identities and Request identities cannot be observed, controlled, polled, retried, Answered, or cancelled from the fork. New children created in the fork belong only to the new Workflow.

Owner `/new`, `/resume`, fork, and clone replacement exhaustively end the source Workflow's transient hosted Runs without changing its transcripts. A new or forked Owner starts a fresh Workflow; resuming an existing Owner reconstructs that session's verified Workflow. Reopening the source Owner reconstructs its verified source Workflow normally. A copied child or Moderator transcript prepared outside Pi's cancellable live fork path is not admitted as a Workflow Owner; participant admission still requires a matching bootstrap for its own Pi session identity.

## Coordination surface

The package registers the Owner tool definitions through Pi's `registerTool()` API when the extension loads, before `session_start`. Pi can therefore reconstruct historical custom tool calls with their native compact renderers during interactive `/resume`. Owner admission then binds those definitions to the identity-scoped coordinator through the hidden extension and activates them. Caller identity and role configuration are never model-supplied tool arguments.

- `agent_spawn` creates one fresh configured child, optionally resolving a named Agent Template, and delivers its initial Creation Request.
- `agent_message` sends Messages, creates correlated Requests, Answers, retrieves, and cancels.
- `ask_user_question` blocks the caller's exact Run on one free-form question. Its matching successful native tool result is the sole Human Answer.
- `agent_observe` returns an authorized Agent's durable identity, structural relationship, bounded primary transcript evidence, current semantic Run state, or direct children. Live retention reasons include a count so concurrent exact Request relationships remain visible without exposing payloads.
- `agent_control` interrupts, explicitly resumes, or terminates one authorized exact child Run.
- `/agents` opens the framed [Agent selector and full-window view](agent-selector.md), with Owner-only Human and Operational attention plus Live and Dormant Agent rosters.

Agent views suspend Owner rendering and attach the physical terminal directly to a selected Agent's PTY. The child reinitializes its own native Pi TUI, which supplies terminal modes, full redraw, editor, footer, widgets, commands, shortcuts, dialogs, and extension UI without an Owner-side frame reconstruction step. A native above-editor dock projects selected identity, semantic work status, scoped direct-child activity, and Owner-only attention without adding an outer view header. The Owner's native transcript, editor, history, queued input, services, diagnostics, footer, and extension context remain mounted and continuously bound while its TUI is suspended. `/agents` retargets the durable physical attachment or restarts and fully redraws the exact Owner presentation without native runtime rebinding.

Coordination roles are trusted protocol participants, not a security boundary. Role-scoped tools constrain the intended workflow and keep caller identity out of model-supplied arguments; they do not isolate mutually hostile code or users.

See [Human Requests](human-requests.md) for the request and Answer shapes, transcript presentation, editor behavior, commitment boundary, and Run fencing behavior. See [Run supervision](run-supervision.md) for authority, status, exact Holds, isolated resumption, termination, and Agent-view retention.

## Activation modes

Coordination activates only when Pi reports interactive TUI mode with UI support. Print, JSON, RPC, and rejected interactive sessions retain the registered tool definitions for transcript rendering but keep them inactive; they register no coordination command and create no coordinator. During interactive admission, the Owner tools remain inactive until the identity-bound coordinator is ready. A factory-time `before_agent_start` gate holds any model turn launched by an earlier extension's `session_start` handler until that admission outcome settles, so the turn sees either the complete Owner coordination surface or inactive Owner tools.

## Host compatibility

Compatibility is determined jointly by the running Pi host's integration shape and native behavioral conformance. Before bootstrapping a Workflow, the package verifies the required public Runtime registration, session binding, interactive input, transcript, resource, extension, TUI, schema, and disposal seams from host-provided peer modules. A missing or malformed seam is reported by its canonical member name, and incompatible startup appends no Owner Identity or partial runtime.

The conformance gate then exercises transcript ordering and branches, model-visible Delivery, sequential Human Requests, Pi-native Agent projections, full-window Owner-preserving views, role-bound extensions, and coordinated disposal against the concrete installed Pi graph. Run it with `npm run test:conformance`; `npm test` remains the complete regression gate.

Pi's version is diagnostic information, not an allowlist. Package builds use a pinned Pi development cohort only to make conformance tests reproducible; installed Pi packages are runtime peers supplied by the host.

## Durable and volatile state

Pi transcripts are the durable authority for Agent identity, authored Messages and Requests, committed Deliveries and Answers, and recovery evidence. Agent Templates and Workflow Policy are resolved from current trusted resources; policy reload publishes complete snapshots but does not write them to transcripts.

Delivery scheduling, execution permits, Human Request attention and Answer mode, Operational Attention, exact Run handles, Holds, and the open Agent-view attachment are volatile and bounded where their owning feature specifies a limit. They are not replayed as durable work after process loss. Polling, explicit retry, and transcript-based cold recovery are the supported recovery paths.

## Shutdown

Orderly Pi shutdown fences spawn, Run-control, Human Request, Moderator, and delivery admission; closes pending Human and Operational Attention UI plus any open Agent view; and clears review timers and volatile scheduling. It then exhaustively ends every retained ordinary child and Moderator before ending the continuously bound Owner through one memoized native runtime path. Cleanup continues after individual failures and reports them together. Every prepared Agent Runtime projection and session is disposed exactly once, including during Owner `/new`, `/resume`, fork, and clone replacement. Abrupt process loss records no graceful-end claim.
