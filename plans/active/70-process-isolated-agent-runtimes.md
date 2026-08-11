# Process-isolated Agent Runtimes

## Goal

Run every non-Owner ordinary Agent and Moderator in its own fresh Pi CLI process and PTY while keeping Workflow authority in the Owner process. Preserve the complete child TUI, durable transcripts, coordination semantics, direct human interaction, cold recovery, and exact Run supervision. Eliminate shared-process extension state so a child cannot overwrite the Owner's lifecycle integration state.

Use Unix domain sockets for the first production Control Transport. Keep the Control Channel interface and bootstrap descriptor transport-neutral so a future named-pipe Adapter can be added without changing coordination, lifecycle, or child-bridge code.

## Intention

Make the OS process the Agent Runtime isolation seam.

The Owner process owns the Workflow graph, policy, scheduling, Requests, Messages, retention, and PTY hosts. Each child process owns exactly one fresh Pi CLI composition root, `AgentSession`, `AgentSessionRuntime`, extension module world, `InteractiveMode`, and session-file writer. A file-backed Runtime Bridge extension translates between Pi lifecycle/tool/UI behavior and the transport-neutral Control Channel.

Keep terminal and control traffic separate:

```text
Owner process
  WorkflowCoordinator
  ProcessAgentHost
    ├─ Terminal Channel: node-pty ↔ child Pi TUI
    └─ Control Channel: framed messages ↔ Runtime Bridge

Child process
  fresh Pi CLI
  fresh extension modules
  real InteractiveMode
  Runtime Bridge extension
```

The Terminal Channel carries ANSI output, input bytes, generated terminal replies, and resize operations. The Control Channel carries typed requests, responses, cancellations, lifecycle events, workflow snapshots, and remote view control. Session JSONL remains the durable recovery record.

## Vocabulary

- **Agent Runtime process**: one non-Owner Pi CLI process that owns one prepared or live Agent Runtime.
- **Runtime Host**: the Owner-side module that supervises one child process, PTY, Control Channel, lifecycle state, and projection.
- **Runtime Bridge**: the child-side file-backed Pi extension that binds local Pi behavior to the Control Channel.
- **Control Channel**: the ordered, bidirectional, request/response/event interface used by Runtime Host and Runtime Bridge.
- **Control Transport**: the byte-stream Adapter below the Control Channel. The first production Adapter is a Unix domain socket.
- **Control Endpoint**: an opaque serialized descriptor telling the child which Control Transport Adapter and address to use.
- **Terminal Projection**: the Owner-side presentation of the child PTY reconstructed from terminal state.
- **Transcript authority**: the only process allowed to mutate a child session JSONL at a given time.

## Scope and constraints

### Required behavior

- Preserve ordinary Agents and Moderators, nested spawning, Messages, Requests, human questions, interruption holds, scheduling, retention, Operational Incidents, cold recovery, and Workflow shutdown.
- Preserve complete child Pi TUI behavior: `ctx.mode === "tui"`, `ctx.hasUI === true`, editor replacement, dialogs, overlays, widgets, footer, status, commands, shortcuts, mouse input, paste, transcript navigation, and resize.
- Preserve `/agents` navigation and activity presentation when input currently targets a child Pi process.
- Preserve durable Agent Identity and transcript evidence. Do not introduce a second durable event store.
- Preserve exact Run state and ordering. A prompt-acceptance response is not settlement; `agent_settled` remains the settlement event.
- Preserve immutable spawn baselines for cwd, model, thinking, ordinary tools, skills, file-backed extensions, and Project Context.
- Keep all Workflow authority in the Owner process. A child tool sends domain intent to the Owner; it does not own a second coordinator.

### Architectural constraints

- Do not modify Pi upstream.
- Do not modify Herdr upstream.
- Do not parse extension source text or source comments.
- Do not require a user-maintained child extension allowlist.
- Do not keep both in-process and process-isolated child implementations after the cutover. The final design has one non-Owner Runtime model.
- Do not weaken children into RPC, print, JSON, or fake-TUI mode.
- Do not let Parent and child `SessionManager` instances mutate the same JSONL concurrently.
- Do not multiplex structured control frames into PTY stdin/stdout.
- Do not implement Windows named pipes in this plan. Unsupported platforms fail fast with a clear diagnostic.
- Do not expose Unix paths, `net.Socket`, PTY handles, JSON framing, or request IDs to coordination modules.

### Product contract

Both Owner and child start through the ordinary Pi CLI composition root. Pi reconstructs its own built-in inline extension factories in every process. Arbitrary test-only factories injected into Pi's exported `main(args, options)` are outside this package's runtime contract.

Inherited extension selection covers file-backed external extensions. Pi-owned built-in inline extensions are local Pi runtime infrastructure and are reconstructed automatically. `extensions: "none"` means no inherited file-backed external extensions; it does not disable Pi's built-ins. Remove the old named-inline inheritance behavior rather than carrying compatibility logic.

## Confirmed feasibility

The throwaway branch `poc/process-isolated-pty`, commit `b1eef85`, proved the vertical process seam under a real Herdr-managed Owner:

- a fresh Pi CLI ran under `node-pty` with a distinct PID and module world;
- the child bridge connected over a Unix domain socket;
- the child reported `mode=tui` and `hasUI=true`;
- a child extension widget rendered through `@xterm/headless`;
- physical Owner input crossed the PTY byte-for-byte;
- resize from 80×24 to 100×30 reached the child;
- a model Run settled with the expected assistant response;
- a durable child transcript was written;
- the child exited without an orphan;
- the Herdr extension loaded while Herdr pane ownership variables were absent;
- `herdr agent prompt --wait` returned and the Owner reached `done`.

The PoC is evidence, not production code. Reimplement the validated design through the production modules and tests; do not merge the prototype directory.

## Target architecture

### Owner process

The Owner retains its current local Pi Runtime. `WorkflowCoordinator` remains authoritative. Non-Owner `AgentRecord`s hold domain identity, durable transcript access, effective configuration, and a Runtime Host interface; they do not expose child `AgentSession`, `AgentSessionServices`, or Pi extension objects.

`ProcessAgentHost` owns:

- the child PTY process and process group;
- one connected Control Channel;
- handshake and protocol admission;
- exact prepared/live/ending/dormant Run state;
- retention and Request relationships;
- the child Terminal Projection;
- child input and resize;
- prompt/Message delivery and interruption;
- graceful shutdown and forced termination;
- transition of transcript authority between dormant Owner-side access and live child-side access.

### Child process

Start the exact installed Pi CLI using the current Node executable and current Pi package entry module, not a potentially different `pi` found through `PATH`:

```text
process.execPath <current-pi-package>/dist/cli.js ...
```

The launch command supplies:

- exact session file/session directory;
- effective cwd;
- effective model and thinking level;
- effective ordinary tool selection;
- `--no-extensions` plus captured file-backed extension paths;
- the file-backed Runtime Bridge extension;
- `--no-skills` plus captured selected skill paths;
- captured project-trust decision;
- an immutable generated Project Context file where required;
- fullscreen TUI mode.

The child process owns its real Pi Runtime and native process lifecycle. Unlike the old embedded mode, it may install normal Pi signal handlers because it is an actual process owner.

The Runtime Bridge captures the child-local `AgentSessionRuntime` through the existing guarded Interactive Host Bridge seam. It maps Control Channel operations to local Pi methods for queueing, interruption, transcript mutation, configuration snapshots, and lifecycle observation. It registers ordinary or Moderator coordination tools according to the immutable child role in the bootstrap descriptor.

### Terminal Projection

`node-pty` owns the child pseudoterminal. `@xterm/headless` tracks the active terminal state. A production Terminal Projection converts terminal cells, attributes, cursor position, and dimensions into the existing Owner TUI presentation seam.

The Adapter must handle:

- ANSI colors and text attributes, not only plain text;
- cursor location and visibility;
- alternate-screen behavior;
- child-generated terminal queries and responses;
- paste and keyboard bytes without reinterpretation;
- mouse coordinate translation through the enclosing Agent view;
- resize ordering between PTY and terminal emulator;
- render invalidation and input-idle observation;
- child exit/failure notification;
- title/progress isolation from the physical Owner terminal.

Terminal-generated replies emitted by `@xterm/headless` must be written back to the PTY. User input remains a separate explicit input path so generated replies and physical keys can be tested independently.

### Transcript authority

Exactly one process mutates a child session JSONL:

1. While no child process is live, the Owner may create, inspect, and mutate the dormant transcript through a local transcript Adapter.
2. Before launch, the Owner commits Agent Identity and immutable startup evidence, closes its writable session handle, and passes the exact session to Pi.
3. After child handshake, the child process is transcript authority. All live evidence mutations use Control Channel operations mapped to the child-local `SessionManager` or `ExtensionAPI.appendEntry()`.
4. After clean child exit and channel closure, the Owner reopens the transcript for dormant inspection/recovery.

Concurrent parent/child writers are an invariant violation. Reads must not rely on stale parent `SessionManager` caches while the child owns the file. Introduce a transcript interface that hides whether the authoritative Adapter is local or remote.

## Control Channel design

### Platform-neutral interfaces

The public control interface contains no Unix-specific concepts:

```ts
type ControlEndpoint =
  | Readonly<{
      transport: "unix";
      address: string;
    }>;

interface ControlTransport {
  write(frame: Uint8Array): Promise<void>;
  onData(handler: (chunk: Uint8Array) => void): () => void;
  onClose(handler: (cause?: Error) => void): () => void;
  close(): Promise<void>;
}

interface AgentControlChannel {
  request<TResult>(
    method: ControlMethod,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<TResult>;
  sendEvent(event: ControlEvent, payload: unknown): Promise<void>;
  onRequest(handler: ControlRequestHandler): () => void;
  onEvent(handler: ControlEventHandler): () => void;
  close(): Promise<void>;
}
```

`UnixSocketControlTransport` is the first production Adapter. `InMemoryControlTransport` is the deterministic test Adapter, making the transport seam real. A future named-pipe implementation extends `ControlEndpoint` and the Adapter factory; Control Channel framing and all callers remain unchanged.

Do not add a transport-selection setting. The host selects the supported platform Adapter internally. On unsupported platforms, admission fails before Child Identity commitment until a platform Adapter exists.

### Endpoint allocation and bootstrap

Create one private listener per Workflow under an appropriate transient runtime directory. Use a short hashed Workflow identifier so Unix socket paths stay below platform limits. Create the containing directory with owner-only permissions and remove the socket on shutdown.

The parent writes an immutable, owner-readable bootstrap descriptor for each child and passes only its path through the child environment:

```ts
type ChildProcessBootstrap = Readonly<{
  protocolVersion: 1;
  endpoint: ControlEndpoint;
  connectionToken: string;
  workflowId: string;
  agentId: string;
  role: "ordinary" | "moderator";
  expectedSessionId: string;
}>;
```

The token binds an accepted connection to one pending spawn; it is not a security boundary. The project remains trust-based.

### Framing

Use newline-delimited JSON over the ordered byte stream. JSON escapes embedded prompt newlines, and terminal bytes never enter this channel. Implement one streaming decoder with a maximum frame size, one serialized writer queue with `drain` backpressure, and fail-fast handling for malformed, oversized, or unknown frames.

Define and TypeBox-validate a closed frame union:

```ts
type ControlFrame =
  | HelloFrame
  | RequestFrame
  | ResponseFrame
  | EventFrame
  | CancelFrame;
```

Every frame contains protocol version and Agent identity. Requests use channel-local correlation IDs. Events use a monotonically increasing connection-local sequence. A request response means accepted/completed operation according to that method's contract; lifecycle settlement remains an explicit event.

The first version has no transparent reconnect, retry, replay, heartbeat, or generic capability negotiation. Unix sockets already provide ordered reliable delivery. Socket closure fails outstanding requests, marks the Runtime unavailable, and starts exact cleanup. Cold recovery creates a new process and channel from durable evidence rather than reconnecting to an unknown old process.

### Protocol operations

Parent-to-child requests:

- `runtime.snapshot`: current cwd/model/thinking/tools/skills/file-backed extensions and session identity;
- `run.prompt`: submit initial or successor user input;
- `message.deliver`: deliver steer/follow-up/next-turn content with explicit semantics;
- `transcript.append`: append coordination evidence while the child is transcript authority;
- `queue.inspect`, `queue.clear`, and `queue.restore`: preserve interruption-hold behavior;
- `run.interrupt`: abort the exact current Run through the child-local Runtime;
- `runtime.shutdown`: request graceful local Pi shutdown.

Child-to-parent requests:

- `coordination.spawn`;
- `coordination.message`;
- `coordination.observe`;
- `coordination.control`;
- `coordination.moderatorControl`;
- human-request domain operations that require Workflow authority;
- Agent-view acquisition/switch/close operations.

Child-to-parent events:

- `runtime.ready` after session and TUI binding;
- `runtime.configurationChanged` after model/thinking/tool/resource changes;
- `agent.start`, `agent.end`, and `agent.settled` with exact Run identity;
- `session.infoChanged` and `session.shutdown`;
- `runtime.attentionChanged`;
- `runtime.fault`;
- remote Agent-view input/selection intent where applicable.

Parent-to-child events:

- Workflow activity/roster snapshots or ordered deltas for the child activity surface;
- remote Agent-view frame updates and closure/failure notifications for views initiated inside a child TUI.

Cancellation is explicit. Aborting a child coordination tool sends `CancelFrame` for its exact request. Aborting an Owner-issued operation sends the corresponding cancellation to the child. Unknown or late cancellation is idempotently ignored only when the request is already terminal; other protocol invariant failures close the channel.

## Runtime and presentation interfaces

### Remove direct child Pi access

The current coordination implementation directly reads and mutates child `AgentSession`, `AgentSessionServices`, `SessionManager`, native queues, abort signals, and `PiNativeAgentProjection`. That cannot cross a process seam.

Introduce intention-revealing interfaces and first adapt the current in-process implementation to them while all behavior remains green. Coordination modules must express domain operations rather than reach through to Pi internals. Representative operations include:

- inspect current Run state and exact handle;
- prepare or admit a Runtime;
- deliver user/custom input;
- append/read transcript evidence through transcript authority;
- inspect/clear/restore queued delivery;
- interrupt/wait for exact settlement;
- snapshot current effective configuration;
- acquire/release a Terminal Projection;
- close/terminate the Runtime.

Do not create a shallow one-method wrapper around every `AgentSession` method. Group operations by the domain invariants already owned by Run supervision, transcript authority, delivery scheduling, and presentation. The existing Owner remains a local Adapter behind the same coordination-facing interfaces where parity is required.

### Complete Agent views

The process cutover must preserve the current complete view behavior rather than replacing it with read-only transcript output.

For the physical Owner view, `AgentViewSurface` attaches directly to the target Runtime Host's Terminal Projection. Input and resize call the PTY Adapter locally.

When `/agents` is invoked inside a child Pi process:

1. the child Runtime Bridge renders its selector/activity UI from Workflow snapshots received over the Control Channel;
2. a selection request goes to the Owner WorkflowCoordinator;
3. the Owner acquires the target projection and emits normalized frame updates to the requesting child;
4. the requesting bridge renders those frames in a native `ctx.ui.custom()` surface;
5. input/resize/close intent returns through the Control Channel to the target Runtime Host;
6. retention and view ownership remain authoritative in the Owner.

Define one Workflow-global active human attachment, matching the existing physical interaction model, so multiple child processes cannot independently resize or drive one target PTY. Reject stale attachment generations mechanically.

## Child process environment

Start from the Owner environment so provider credentials, proxies, locale, `HOME`, runtime configuration, and executable discovery continue to work. Remove environment variables that claim ownership of the physical Herdr pane before spawning the child:

```text
HERDR_ENV
HERDR_SOCKET_PATH
HERDR_PANE_ID
```

Keep this policy in one Herdr integration Adapter, not in generic Runtime Host or Control Channel code. The Runtime Bridge may load the Herdr extension as an inherited file-backed resource; without pane ownership it remains inert. Do not identify Herdr by parsing extension source or comments.

Also provide the child bootstrap descriptor path and normal PTY terminal variables. Do not pass the Owner Control Endpoint or connection token on the command line, where it would appear in process listings.

## Resource inheritance

Snapshot effective resource references automatically; no user-maintained allowlist is introduced.

- File-backed extensions: capture canonical resolved paths, exclude this package's Owner entry module by package identity, and pass the remaining paths as repeated explicit `-e` arguments after `--no-extensions`.
- Pi built-in inline extensions: reconstruct automatically through the fresh Pi CLI; do not serialize factories or include `<inline:...>` in the durable extension baseline.
- Runtime Bridge: add its file path explicitly and separately from inherited external extensions.
- Skills: snapshot selected skill source paths and pass them explicitly after `--no-skills`.
- Project Context and effective AGENTS content: materialize one immutable Run context artifact and pass it through Pi's supported prompt options while disabling rediscovery that would violate the baseline.
- Model, thinking, tools, cwd, trust, and session: pass explicit CLI arguments derived from the immutable configuration.

After handshake, ask the child for `runtime.snapshot` and compare the effective result to the launch blueprint before admitting model work. Mismatch fails startup and cleans up the process before Child Identity becomes externally usable.

## Work plan

Implementation must grow in working layers. Tests precede each behavior change. Enabling refactors and behavior changes stay in separate commits.

### Milestone 1 — Lock acceptance and protocol behavior

1. Convert the PoC findings into focused production-facing failing tests without copying prototype modules.
2. Add process acceptance fixtures proving distinct PID/module state, real TUI mode/UI, lifecycle ordering, PTY render/input/resize, transcript creation, and no orphan.
3. Add a deterministic Herdr-lifecycle fixture that has module-level session state and physical-pane ownership semantics, plus a final manual real-Herdr gate.
4. Record an acceptance matrix mapping current child UI, scheduling, messaging, recovery, and shutdown behavior to process-host evidence.

Checkpoint: the existing in-process product still passes; new process acceptance tests are red for the missing implementation.

### Milestone 2 — Implement the transport-neutral Control Channel

1. Define TypeBox schemas for endpoints, bootstrap descriptors, frames, methods, events, and method payload/results.
2. Implement streaming NDJSON framing, frame-size enforcement, serialized writes/backpressure, request correlation, cancellation, event sequencing, deterministic close, and outstanding-request failure.
3. Implement `InMemoryControlTransport` and exhaustive channel contract tests.
4. Implement Unix endpoint allocation, listener, connector, permissions, path-length handling, stale cleanup, and `UnixSocketControlTransport`.
5. Add platform admission that selects Unix internally and fails fast elsewhere.

Checkpoint: channel conformance passes identically over in-memory and Unix socket Adapters; no coordination code knows the endpoint kind.

### Milestone 3 — Remove child `AgentSession` from coordination interfaces

1. Extract a coordination-facing Runtime Host interface from `InProcessAgentHost`.
2. Introduce transcript-authority and effective-configuration snapshot interfaces.
3. Refactor Messages, Requests, spawning, delivery scheduling, interruption holds, evidence, activity status, and Workflow shutdown to call domain operations instead of child Pi objects.
4. Generalize the projection seam from `PiNativeAgentProjection` to a Terminal Projection interface without changing behavior.
5. Remove `AgentRecord.services` and direct non-Owner `requireLiveSession`/`requireLiveServices` usage.
6. Keep the local Owner Adapter and temporary in-process child Adapter fully green through the new interfaces.

Checkpoint: production behavior is unchanged, but coordination modules no longer require an in-memory child Pi Runtime. This enabling refactor is committed separately.

### Milestone 4 — Implement the child Runtime Bridge and process launcher

1. Add a separate file-backed child extension entry that installs the guarded Interactive Host Bridge but never bootstraps an Owner Workflow.
2. Read and validate the immutable bootstrap descriptor before binding the child role.
3. Connect and complete hello/session/TUI readiness handshake.
4. Map local Pi lifecycle, queue, interruption, configuration snapshot, transcript append, and shutdown operations to the Control Channel.
5. Register ordinary and Moderator tool sets as child-side Adapters to Owner-owned domain operations.
6. Build the exact Pi CLI command from the immutable Run blueprint.
7. Build the child environment through the isolated Herdr ownership Adapter.
8. Add startup rollback for CLI failure, trust failure, extension failure, handshake timeout, configuration mismatch, and early process exit.

Checkpoint: a process can start, prepare, report exact configuration, run one prompt, settle, and shut down through the production Control Channel without presentation cutover.

### Milestone 5 — Implement ProcessAgentHost and transcript handoff

1. Implement PTY/process ownership, Control Channel binding, exact lifecycle state, retention, and cleanup behind the Runtime Host interface.
2. Create/commit initial durable Identity locally, close local write authority, launch the child on that exact session, and admit remote transcript authority only after handshake.
3. Route live transcript mutations through the child and reopen local dormant transcript access only after exact exit.
4. Implement prompt and Message delivery, queue inspection/clear/restore, interruption, settlement, failure, termination, and retained prepared Runtime behavior.
5. Make channel loss and process exit produce one deterministic Run end cause and reject every outstanding operation.
6. Make child bridge socket loss trigger graceful self-termination so Owner death does not leave an active orphan.

Checkpoint: ordinary and Moderator lifecycle/scheduling tests pass with ProcessAgentHost while the existing view path remains isolated behind its interface.

### Milestone 6 — Replace child projection with PTY Terminal Projection

1. Move `node-pty` and `@xterm/headless` to production dependencies.
2. Implement styled terminal-cell rendering, cursor, alternate screen, generated terminal replies, input, paste, mouse, resize, render invalidation, and disposal.
3. Adapt `AgentViewSurface` and durable attachment to the Terminal Projection interface.
4. Preserve prepared/Dormant selection, startup dialogs, custom editors, overlays, widgets, footer, scrolling, mouse, and Owner restoration.
5. Add real PTY regressions for input byte fidelity and separate Pi editor/autocomplete behavior so terminal transport is not blamed for editor completion semantics.

Checkpoint: complete physical Owner interaction with ordinary and Moderator child Pi processes matches the current acceptance matrix.

### Milestone 7 — Complete remote coordination and child-originated views

1. Route all ordinary and Moderator coordination tools through typed domain methods and preserve current receipts/errors.
2. Preserve nested spawn and immutable descendant-baseline capture through `runtime.snapshot` rather than parent access to child services.
3. Preserve Messages, Requests, cancellation, answer retention, human questions, moderation, and Operational Incident behavior.
4. Stream Workflow activity state to each Runtime Bridge.
5. Implement child-native `/agents` selector/activity UI, remote view attachment generations, frame updates, input/resize forwarding, Agent-to-Agent switching, and return to Owner.
6. Test cancellation and process/channel failure during every pending tool and view operation.

Checkpoint: all public coordination and complete Agent-view tests pass against process-isolated children.

### Milestone 8 — Cold recovery, races, and shutdown

1. Respawn cold-recovered Agents on their exact verified transcript and immutable Identity configuration.
2. Cover Owner shutdown during spawn, handshake, startup dialog, model work, tool request, remote view, input processing, and transcript handoff.
3. Cover child crash, protocol violation, socket loss, PTY failure, model failure, extension failure, and forced kill.
4. Verify no orphan processes, socket files, listeners, PTYs, timers, watchers, or stale transcript writers remain.
5. Stress concurrent children, nested descendants, rapid selection, interruption/resumption, and repeated successor Runtimes.

Checkpoint: lifecycle and active-handle baselines remain stable across repeated focused and full-suite runs.

### Milestone 9 — Remove obsolete in-process child machinery

1. Delete the in-process child session factory and child-only native projection machinery after the process path satisfies the full acceptance matrix.
2. Remove named-inline inheritance, private factory-registry host checks, tests, and documentation.
3. Remove process-global child theme/keybinding restoration and embedded child process-lifecycle suppression that no longer apply.
4. Keep only Owner-local host bridge seams still required by Owner bootstrap and child-local Runtime Bridge capture.
5. Remove temporary dual-path switches and test compatibility shims.
6. Rewrite user-facing documentation to state the process-isolated design directly.

Checkpoint: one non-Owner Runtime architecture remains; no fallback or legacy path survives.

### Milestone 10 — Final validation and plan closure

1. Run focused protocol, process, transcript, lifecycle, presentation, coordination, and recovery suites.
2. Run full regression and conformance repeatedly enough to expose process-order races.
3. Run the exact real-Herdr Owner → child → Owner reproduction and capture the final applied Owner idle state.
4. Run package, dependency, source-shipping, and active-handle gates.
5. Complete independent architecture, standards, and acceptance review.
6. Move this plan to `plans/done/` only after every acceptance row has evidence.

## Validation

Required automated gates:

- Control Channel contract against in-memory and Unix socket Adapters.
- Frame fragmentation/coalescing, malformed/oversized frames, backpressure, cancellation, close, and sequence tests.
- Process handshake, configuration mismatch, early exit, channel loss, graceful shutdown, forced termination, and no-orphan tests.
- Transcript-authority tests proving no concurrent writers and correct local/remote handoff.
- Ordinary, Moderator, nested spawn, Messages, Requests, human question, scheduling, interruption, moderation, and Operational Incident suites.
- Complete Terminal Projection tests for styles, cursor, query replies, input bytes, paste, commands, shortcuts, widgets, dialogs, overlays, mouse, scroll, resize, and failure.
- Cold recovery and repeated successor tests.
- Existing Owner isolation and exact restoration tests.
- `npm run typecheck`.
- `npm test`.
- `npm run test:conformance`.
- `npm pack --dry-run` with child bridge and runtime dependencies present.
- `npm audit --omit=dev`.
- `git diff --check`.

Required real integration gate:

1. Start a Herdr-managed Pi Owner with the coordination package.
2. Ask it to spawn and await a process-isolated child.
3. Confirm the child owns a different PID, a real TUI, and no Herdr physical-pane environment.
4. Confirm the child settles and exits or remains retained according to policy.
5. Confirm the Owner visibly settles.
6. Confirm `herdr agent prompt --wait` returns and Herdr reaches `done`/underlying `idle` for the Owner session.
7. Confirm no child process or transient socket remains after shutdown.

Future-platform extensibility gate:

- No coordination, lifecycle, transcript, child bridge, or presentation module imports Unix socket modules or handles Unix addresses directly.
- Endpoint parsing and Transport construction are centralized.
- Channel contract tests run unchanged against every Adapter.
- Unsupported-platform failure occurs before Child Identity commitment and leaves no durable partial Agent.

## Progress

- [x] Diagnosed the Herdr stale-working failure and captured the exact mis-tagged lifecycle sequence.
- [x] Rejected source-comment extension identification and fully reverted it.
- [x] Proved a fresh Pi CLI/PTY/Unix-socket vertical slice on throwaway branch `poc/process-isolated-pty` at `b1eef85`.
- [x] Confirmed the standard Pi CLI reconstructs Pi-owned inline factories in every process.
- [x] Confirmed real Herdr settlement, real child TUI, PTY input/resize, durable transcript, and clean child exit in the PoC.
- [x] Approved and moved to `plans/active/` on implementation branch `feat/process-isolated-agent-runtimes`.
- [x] Preserved the pre-cutover implementation on branch `archive/in-process-agent-runtimes` at `3f84e97`.
- [x] Implemented the typed transport-neutral Control Channel, in-memory Adapter, Unix socket Adapter, and platform admission.
- [x] Extracted the process-neutral Terminal Projection seam and proved real PTY parsing, input, generated replies, resize, and exit.
- [x] Added exact Pi child CLI launch construction and physical Herdr pane environment isolation.
- [x] Completed the production Runtime Bridge/Process Runtime vertical slice with real Pi CLI/TUI, offline model lifecycle, exact session, token admission, PTY input/resize, and bounded termination.
- [x] Routed coordination transcript reads through `AgentTranscript` and added a fresh-file inspection Adapter.
- [x] Materialized the exact pre-launch JSONL only after validating committed Agent Identity and immutable Runtime Blueprint evidence.
- [x] Committed role-bound immutable Runtime Blueprint evidence for ordinary and Moderator admissions, including exact selected skill sources, trust, and effective context files.
- [x] Added a process-safe one-shot child blueprint resolver that uses public Pi resource APIs without evaluating inherited extension factories and rejects arbitrary per-child extension paths.
- [x] Routed coordination through process-neutral Runtime Host intentions and removed live child `AgentSession`/services reach-through from coordination operations.
- [x] Extracted handler-driven participant coordination tool schemas, renderers, role sets, and registration without changing local receipts.
- [x] Adapted real child PTY frames to the Terminal Projection surface, including styled/wide cells, cursor presentation, focus, resize, failure/exit, final-output drain, and owned process-group cleanup.
- [x] Finished the Control-backed hosted-Runtime Adapter and truthful pre-admission projection/cancellation, including exact Run targeting, durable Delivery commit proof, terminal channel/exit failure synthesis, and ordered queue intentions.
- [ ] Finish awaited participant lifecycle and coordination tool proxying, then ordinary/Moderator process cutover and Milestones 4–10.

## Surprises and discoveries

- The child did publish idle in the original failure. The Owner's final idle was tagged with the child session path because Pi reused one cached file-extension factory closure containing Herdr's module-global session reference. Herdr correctly refused to apply child-session idle to the Owner session.
- A fresh extension factory invocation is not fresh module evaluation. A fresh Pi process is.
- Pi's standard CLI calls `main(process.argv.slice(2))`; the custom in-memory factory option exists in the exported composition function but is not part of the actual CLI launch contract.
- The current coordinator is more tightly coupled to child Pi objects than the session factory alone suggests. Messages, evidence, delivery, interruption, selection, and shutdown directly use child `AgentSession` and `SessionManager`; the enabling Runtime Host/transcript refactor is mandatory before process cutover.
- The complete child UI is easier to preserve by running a real Pi TUI in a PTY than by serializing extension UI callbacks or lying about mode.
- Pi defers creating a new session JSONL until an assistant message exists; custom-only Agent Identity evidence remains only in the creating `SessionManager`. Exact `--session <path>` process launch therefore needs an explicit one-time transcript materialization step for the header and committed Identity before handing authority to the child.
- The PoC forwarded physical input byte-for-byte. Pi slash-command autocomplete changed the final command argument before invoking the handler, so production tests must inspect raw transport bytes separately from editor completion behavior.
- Process isolation does not automatically remove inherited external ownership identity. The child environment must omit Herdr's documented pane-ownership variables even though the Herdr module itself is isolated.

## Decisions

- Use one OS process and real Pi CLI/TUI per non-Owner prepared Runtime.
- Use Unix domain sockets now, behind a transport-neutral Control Channel and endpoint descriptor.
- Add no user-facing transport configuration until a second production Adapter exists.
- Use one Workflow listener and one accepted channel per live child.
- Use NDJSON for structured frames; keep ANSI terminal traffic on the PTY.
- Keep Workflow authority and Run supervision in the Owner process.
- Make the child process sole transcript authority while live.
- Reconstruct Pi-owned inline factories locally and remove arbitrary named-inline inheritance.
- Snapshot file-backed extensions and skill paths automatically; do not introduce user-maintained lists.
- Resolve Template and resources once before Agent Identity; successor and cold Runtimes reuse that one committed immutable blueprint rather than rerunning mutable Template/resource discovery.
- Strip Herdr physical-pane ownership through one isolated environment Adapter.
- Preserve complete TUI behavior and `/agents`; do not replace it with RPC or read-only rendering.
- Fail closed on protocol/channel loss and recover by starting a fresh process from durable evidence, not by reconnecting.
- Remove the in-process child path after cutover; retain no compatibility fallback.

## Outcomes and retrospective

Not started. This section will record the final architecture, acceptance evidence, removed machinery, remaining platform limitation, and lessons after implementation.
