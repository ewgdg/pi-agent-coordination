# Backend-neutral Agent Run capability surface

**Research ticket:** [#3](https://github.com/ewgdg/pi-agent-coordination/issues/3)  
**Evidence baseline:** Pi `0.82.0` (`083e6162`); Herdr `0.7.5` (`ef4c23f5`)  
**Researched:** 2026-07-25

## Decision

A live coordination protocol can require an Agent Run backend to provide these capabilities:

1. **Fenced run identity** — an opaque run ID plus an incarnation that cannot be confused with a replacement process.
2. **Readiness-confirmed launch** — launch or resume in a working directory, bind the intended session, and return only after the control channel and expected agent incarnation are ready.
3. **Separate process, work, and attention observations** — process liveness/exit, agent work activity/settlement, and input-required attention are independent facts, each able to report `unknown`.
4. **Snapshot plus ordered observation** — obtain current state and then observe changes without treating a disconnected event stream as proof of inactivity.
5. **Acknowledged local submission** — send a request over a backend-owned local channel and distinguish accepted/rejected delivery from eventual work outcome.
6. **Semantic interruption** — request cancellation of current agent work and observe the postcondition; a terminal key gesture is only a best-effort fallback.
7. **Termination confirmation** — request process termination, then independently confirm that the bound incarnation exited. Closing a UI/container resource is not confirmation.
8. **Exclusive session writing** — acquire a fenced lease for an opaque session key before launch/resume, reject a second live writer, and release only after confirmed termination.

These are protocol capabilities, not Herdr objects. Workspaces, tabs, panes, terminal IDs, screen buffers, key names, socket paths, process-group IDs, and Herdr's `done`/seen behavior belong entirely inside a Herdr adapter.

The reviewed seams support only a **composite** implementation:

- Pi RPC or SDK is the strongest seam for agent lifecycle, accepted input, settlement, semantic abort, and session identity.
- Herdr is a strong optional host adapter for persistent terminals, readiness-checked interactive launch, process snapshots, occupant-fenced waits, and terminal fallback control.
- A coordination-owned lease store is required for session single-writer safety. Neither Pi nor Herdr currently supplies that invariant.
- Strict termination confirmation is not available from Herdr `pane.close` alone and must be added below or beside that adapter.

## Why one status enum is insufficient

Three timelines exist:

| Axis | Backend-neutral observations | Meaning |
| --- | --- | --- |
| Process | `launching`, `alive`, `terminating`, `terminated`, `unknown` | Whether the bound OS/runtime incarnation exists. |
| Work | `ready`, `active`, `settled`, `unknown` | Whether the agent is ready, doing work, or has no automatic continuation left. |
| Attention | `none`, `input_required`, `unknown` | Whether recognized interaction is required. |

`settled` does **not** mean process exit, request success, or workflow completion. Pi emits `agent_settled` only after retries, compaction retries, and queued continuations are exhausted, while the RPC process remains available for another prompt.[^pi-rpc-settled] Herdr likewise defines an agent as a process inside a pane, and its idle/done states do not terminate that process.[^herdr-automation-model]

Herdr's `done` is the same underlying idle condition as `idle`, distinguished by whether the tab has been seen. Focusing changes `done` to `idle`; reading via CLI does not.[^herdr-status-meaning] That is useful presentation state, but it cannot be protocol work completion.

`unknown` must remain first-class. Herdr explicitly says `unknown` means classification is not confident and does not prove successful completion.[^herdr-status-meaning] A failed observation call or disconnected stream must similarly remain unknown rather than being collapsed into idle, missing, or terminated.

## Required capability seams

The following TypeScript is an interface sketch, not a wire schema. It shows where responsibilities belong.

```ts
type RunId = string;
type Incarnation = string;
type ObservationCursor = string;
type SessionKey = string;       // Opaque outside the backend/lease adapter.
type FenceToken = string;

type Observed<T> =
  | { certainty: "observed"; value: T; observedAt: string }
  | { certainty: "unknown"; reason: string; observedAt: string };

interface AgentRunBackend {
  capabilities(): Promise<RunBackendCapabilities>;

  launch(input: {
    runId: RunId;
    incarnation: Incarnation;
    workingDirectory: string;
    session: { intent: "new" } | { intent: "resume"; key: SessionKey };
    sessionFence: FenceToken;
    profile: string;
  }): Promise<LaunchReceipt>;

  snapshot(runId: RunId, incarnation: Incarnation): Promise<RunSnapshot>;
  observe(
    runId: RunId,
    incarnation: Incarnation,
    after?: ObservationCursor,
  ): AsyncIterable<RunObservation>;

  submit(input: {
    runId: RunId;
    incarnation: Incarnation;
    requestId: string;
    content: string;
    delivery: "now" | "steer" | "follow_up";
  }): Promise<{ disposition: "accepted" | "rejected"; reason?: string }>;

  interrupt(input: {
    runId: RunId;
    incarnation: Incarnation;
    requestId: string;
  }): Promise<{ disposition: "accepted" | "already_settled" | "unsupported" }>;

  requestTermination(input: {
    runId: RunId;
    incarnation: Incarnation;
    mode: "graceful" | "force";
  }): Promise<{ disposition: "accepted" | "already_terminated" | "unknown" }>;

  awaitTermination(
    runId: RunId,
    incarnation: Incarnation,
    deadline: string,
  ): Promise<Observed<{ exitedAt: string; exitCode?: number; signal?: string }>>;
}

interface SessionWriterLeases {
  acquire(input: {
    session: SessionKey;
    runId: RunId;
    incarnation: Incarnation;
  }): Promise<{ disposition: "acquired"; fence: FenceToken } | { disposition: "held" }>;

  renew(session: SessionKey, fence: FenceToken): Promise<"renewed" | "fenced_out">;
  releaseAfterTermination(session: SessionKey, fence: FenceToken): Promise<void>;
}
```

The decomposition is deliberate:

- `AgentRunBackend` adapts Pi SDK/RPC, another agent runtime, or a hosted interactive terminal.
- `SessionWriterLeases` is coordination infrastructure. It must not be inferred from a pane name, PID, session file's existence, or a backend's local in-memory map.
- The protocol stores only opaque backend locators as adapter metadata. It does not make those locators domain identity.

### 1. Fenced run identity

A public run ID is not enough. A restarted or replaced agent can reuse the same logical run ID while being a different process. Every command and observation therefore needs an **incarnation** (generation/fence).

Herdr demonstrates the required behavior in its wait implementation: `agent.wait` pins the resolved terminal occupant, and fails with `agent_not_running` if the terminal, agent name, agent kind, pane, or occupant changes; a replacement cannot satisfy the old wait.[^herdr-wait-doc][^herdr-wait-source] The backend-neutral contract should preserve that safety without exposing `terminal_id` or `pane_id`.

PIDs are evidence, not identity. They can be absent, platform-specific, or reused. Herdr's process snapshot includes a shell PID, optional foreground process-group ID, and foreground process records when available.[^herdr-process-info] The adapter should retain those only as diagnostic evidence behind `(runId, incarnation)`.

### 2. Readiness-confirmed launch

`launch()` should not mean only that a spawn syscall succeeded. A successful receipt must establish:

- the intended process incarnation is alive;
- the expected agent/control protocol is responsive;
- the working directory/profile was applied;
- the requested new/resumed session is bound and reported;
- the session fence is still current.

Herdr's `agent start` is a useful reference: it requires an already available shell pane, launches a supported canonical agent, and returns only after detecting the expected agent in the same terminal as ready for interactive input.[^herdr-launch] The layout requirement is Herdr-specific and stays inside its adapter.

Pi RPC exposes `get_state`, including `isStreaming`, session file, and session ID, so a Pi adapter can turn subprocess spawn into a stronger launch by probing the RPC channel and verifying the session after startup.[^pi-rpc-state] Pi's bundled `RpcClient.start()` itself only waits 100 ms and checks that the process has not exited; it is not a readiness proof.[^pi-rpc-client-start]

Launching and submitting the first request may be implemented atomically by a backend, but the protocol should not assume that all backends can. When they are separate operations, a crash between `launch` and `submit` must leave a recoverable accepted/not-accepted record in coordination storage.

### 3. Snapshot and ordered observation

A backend must expose a current snapshot. Event streaming is valuable but cannot be the only truth source.

Pi RPC streams agent, turn, message, and tool events and exposes `get_state`; `agent_settled` is the definitive no-more-automatic-work event.[^pi-rpc-events] Herdr exposes `session.snapshot` for bootstrap and instructs clients to subscribe afterward, resnapshot after reconnect, and refresh whenever the local cache may be stale.[^herdr-snapshot]

A protocol observation needs:

- `(runId, incarnation)`;
- adapter observation sequence or cursor where available;
- observation time;
- process/work/attention axes;
- source and certainty;
- explicit discontinuity/resnapshot indication after reconnect.

Neither upstream proves a durable, replayable event log across process/server replacement. Herdr says live handoff may interrupt in-flight requests, waits, subscriptions, client sockets, and pane-to-pane messages; clients should reconnect and retry.[^herdr-handoff] Therefore the protocol cannot require gap-free backend event replay. It can require resnapshot-and-reconcile behavior.

### 4. Acknowledged direct local submission

The required semantic is **accepted delivery**, not prompt completion:

- request IDs make retries idempotent at the protocol/adapter boundary;
- the adapter returns accepted or rejected;
- delivery order is defined per run;
- `now`, `steer`, and `follow_up` are capability-negotiated modes;
- eventual work result is observed separately.

Pi RPC is the strongest proven local channel. It uses strict LF-delimited JSONL over stdin/stdout, supports request IDs, rejects an unqualified prompt while already streaming, and reports success when a prompt is accepted, queued, or handled.[^pi-rpc-framing][^pi-rpc-prompt] `steer` is delivered after the current assistant turn's tool calls; `follow_up` waits until the agent finishes current work.[^pi-rpc-queue]

Herdr also exposes newline-delimited JSON over a local Unix-domain socket or a Windows named pipe.[^herdr-transport] Its `agent.prompt` verifies the current recognized occupant, atomically encodes prompt text plus Enter according to live terminal mode, and can combine prompt and wait in one socket request.[^herdr-prompt-source][^herdr-wait-doc] Those are Herdr adapter mechanics.

Herdr explicitly does not track individual prompt turns; if the agent is already working, the active turn's completion may satisfy a prompt wait.[^herdr-prompt-wait] Pi's prompt acceptance response also is not a request-completion receipt; later failures arrive through the event/message stream.[^pi-rpc-prompt]

**Conclusion:** neither seam currently proves exact `requestId -> completed turn` correlation. Workflow request completion must be a separate protocol fact, such as a durable agent acknowledgment/result, not inferred from the next idle/settled observation.

### 5. Semantic interruption

The protocol operation is an intent: cancel current agent work for the bound incarnation. Its success requires a later observed postcondition, normally work `settled`, while process state remains `alive`.

Pi's `AgentSession.abort()` cancels retry, calls the agent abort, and waits for idle; RPC's `abort` awaits that method before responding.[^pi-abort-source][^pi-rpc-abort] This is a proven semantic interruption seam.

Herdr can send logical `esc` or `ctrl+c` keys after validating the current live agent and all key names before writing bytes.[^herdr-keys] That proves the input was accepted by the terminal runtime, not that the agent cancelled. A Herdr adapter may expose this as `bestEffortTerminalInterrupt`, but it must not report semantic interruption complete until authoritative lifecycle observation advances.

POSIX signal names and key names must not appear in the protocol. Windows does not implement Unix foreground process groups, and Herdr maps process shutdown differently across platforms.[^herdr-windows]

### 6. Termination and independent confirmation

Termination is different from interruption:

- **interrupt** stops current agent work but keeps the run process usable;
- **terminate** ends the process incarnation;
- **close/remove** may remove a backend resource without proving all processes exited.

The backend contract must separate `requestTermination()` from `awaitTermination()`. A timeout or inaccessible observer produces `unknown`, never `terminated`.

Herdr's pane runtime attempts HUP, TERM, and KILL with 250 ms waits on Unix; on Windows HUP is a no-op and TERM/KILL both call `TerminateProcess`. After all attempts, the runtime can log that processes are still alive.[^herdr-shutdown-source][^herdr-windows-kill] `pane.close` drains that runtime and then returns `ok`, but the API response carries no shutdown outcome.[^herdr-close-source]

**Therefore `pane.close` is not a termination-confirmation capability.** A Herdr adapter needs an added process-supervisor seam that retains the bound process evidence and confirms exit, or it must return termination certainty `unknown` and keep the session lease fenced.

Herdr's spontaneous `pane.exited` event is valid positive evidence that the pane process exited, but `pane.closed` is a resource-lifecycle event and is not equivalent.[^herdr-events] Pi's child-process `exit`/`close` observation can provide positive process evidence. The bundled RPC client's `stop()` waits for exit but resolves after a one-second kill timeout even if no exit event arrived, so that helper also must not be treated as strict confirmation without an additional check.[^pi-rpc-client-stop]

### 7. Exclusive session writer lease

A session is the durable conversation identity, not the process or hosting surface. The protocol should represent it as an opaque `SessionKey` namespaced by backend. Pi may implement that key with a session UUID and/or JSONL path; Herdr may learn it from official integration-reported agent-session metadata. Those representations stay adapter-private.

The lease invariant is:

1. acquire before launching or resuming a writer;
2. pass a fence token into the launch transaction;
3. reject or stop a writer that cannot prove the current fence;
4. renew while the run may write;
5. never release merely because observation is unavailable;
6. release only after termination is confirmed, or after an explicit operator recovery decision backed by independent evidence.

Pi's session manager opens existing session files without an exclusive lease and persists entries with ordinary synchronous append operations; no ownership/fencing API appears in the session surface.[^pi-session-source] A local executable probe against Pi `0.82.0` confirmed the consequence: two simultaneous RPC processes opened the same pre-created session, both returned success from `get_state` and `set_session_name`, and both appended independent parent chains to the same JSONL file. The reproducible shape was:

```text
create one valid session header
start two: pi --mode rpc --session <same-file>
for each: get_state
concurrently for each: set_session_name
```

Both remained alive and both writes succeeded. This proves that a Pi adapter must enforce exclusivity outside `SessionManager`.

Herdr's unique live agent names and occupant-pinned waits do not lease native agent sessions. Herdr can expose a reported native session reference and can decline duplicated references during cold restore, but that is not live single-writer admission.[^herdr-session-reference][^herdr-session-restore]

Session replacement during a coordinated run must either be disabled or modeled explicitly. If a backend changes its native session identity, the adapter must acquire the new session lease and atomically update the run binding before further writes. A display rename or hosting-surface move is not a session identity change.

## Capability negotiation

Not every backend will satisfy every strong capability. Advertise semantics, not implementation names:

```ts
interface RunBackendCapabilities {
  lifecycle: {
    workSettlement: "authoritative" | "heuristic" | "none";
    attention: "authoritative" | "heuristic" | "none";
  };
  communication: {
    acceptedSubmission: boolean;
    steer: boolean;
    followUp: boolean;
    perRequestCompletionCorrelation: boolean;
  };
  interruption: "semantic" | "terminal_gesture" | "none";
  processObservation: "incarnation_exit" | "liveness_only" | "none";
  terminationConfirmation: boolean;
  resumableSessionIdentity: boolean;
}
```

Admission policy for a protocol-managed live Agent Run should require:

- accepted submission;
- snapshot/reconciliation;
- process exit observation;
- termination confirmation;
- session identity plus coordination-owned writer lease;
- either authoritative work settlement, or a separate durable agent completion handshake.

Heuristic attention is useful but not mandatory. Raw screen reading, raw keys, terminal attachment, pane layout, focus, UI labels, and process command lines are optional diagnostics/operations.

## Herdr adapter mapping

This mapping is intentionally confined to the adapter:

| Protocol capability | Herdr 0.7.5 mechanism | Adapter rule |
| --- | --- | --- |
| Hosting locator | private workspace/tab/pane/terminal records | Never expose as run or session identity. |
| Readiness launch | `agent.start` against an available pane | Return ready only after expected occupant and interactive readiness; pre-create topology privately. |
| Process snapshot | `pane.process_info`, `pane.get`, `pane.exited` | Normalize platform gaps; retain PIDs only as evidence. |
| Work/attention | lifecycle integration or screen-manifest agent status | Mark source authoritative vs heuristic; discard `done`/seen distinction. |
| Snapshot/events | `session.snapshot`, `events.subscribe`, agent waits | Resnapshot after disconnect; fence waits to the original occupant. |
| Submit | `agent.prompt` | Accepted input only; do not infer request completion from wait. |
| Terminal fallback | `agent.send_keys`, pane reads | Advertise as best effort/diagnostic, never semantic proof. |
| Terminate | `pane.close` plus added supervisor | Do not release the session lease on close response alone. |
| Native session locator | `agent_session` metadata | Convert to backend-namespaced opaque session key. |
| Local transport | CLI wrapper or raw UDS/named pipe | Hide socket form/path and reconnect mechanics. |

Herdr distinguishes full-lifecycle hook authorities from screen detection and avoids running both as competing status authors.[^herdr-authority] The adapter should preserve source/certainty metadata rather than pretending every status has the same quality.

## Pi adapter mapping

| Protocol capability | Pi 0.82.0 mechanism | Adapter rule |
| --- | --- | --- |
| Control channel | SDK `AgentSession`, or RPC JSONL over child stdio | Prefer RPC for process isolation; use strict LF framing. |
| Ready probe | RPC `get_state` or SDK state after construction | Do not use a fixed startup sleep as readiness. |
| Work lifecycle | `agent_start`, turn/tool/message events, `agent_settled` | Map `agent_settled` to work settled, not process terminated or workflow complete. |
| Submit | `prompt`, `steer`, `follow_up` | Persist protocol request receipt before/with send; success is acceptance only. |
| Interrupt | `abort()` | Observe settled postcondition; keep process alive. |
| Process exit | child-process exit/close owned by adapter | Keep separate from AgentSession events. |
| Session locator | `sessionId`, optional `sessionFile` | Namespace and keep opaque outside adapter. |
| Writer exclusivity | external lease/fence | Never rely on `SessionManager` or append behavior. |
| Terminate | graceful child shutdown, escalation, exit observation | Report confirmed only after exit evidence. |

The SDK exposes `prompt`, `steer`, `followUp`, subscriptions, `isStreaming`, `abort`, and `waitForIdle`; session replacement is a distinct runtime layer.[^pi-sdk-surface] That separation supports keeping live run control independent from session switching.

## Cross-platform constraints

1. **Transport:** Herdr raw clients use Unix-domain sockets on Unix and named pipes on Windows. Portable adapters should normally invoke the CLI wrapper or abstract both transports.[^herdr-transport]
2. **Process model:** Unix foreground process groups are unavailable on Windows. Herdr Windows detection scans descendants of the pane shell instead.[^herdr-windows-process]
3. **Termination:** Unix HUP/TERM/KILL semantics do not carry to Windows; Herdr's Windows HUP is a no-op and both later modes use `TerminateProcess`.[^herdr-windows-kill] Protocol operations must express graceful/force intent and observed outcome, not signals.
4. **Terminal control:** Native Windows does not support Herdr direct terminal attach, `--remote`, live handoff, or Unix FD handoff in the beta.[^herdr-windows]
5. **Shell:** Pi's bash tool requires a bash installation on Windows, but the Agent Run control protocol should not require shell text when argv or RPC is available.[^pi-windows]
6. **Paths:** session paths and socket paths are backend-local. They cannot serve as globally portable domain IDs.
7. **Reconnect:** Herdr live handoff and server replacement can break transient requests/subscriptions. The adapter must resnapshot and make retries idempotent.[^herdr-handoff]

## Facts not currently provable

| Claim | Status | Consequence |
| --- | --- | --- |
| A Herdr `pane.close` success means every pane descendant exited. | **Disproved as a guaranteed API postcondition.** Source permits a still-alive warning and returns no termination result. | Add an exit-confirming supervisor or keep termination unknown. |
| A Herdr prompt wait corresponds to the prompt just submitted. | **Disproved.** It does not track turns; existing active work may satisfy it. | Do not derive request completion from the wait. |
| Pi prevents two processes from writing one session. | **Disproved for 0.82.0.** Source and executable probe allow simultaneous writers. | Lease and fence externally. |
| Every Pi/Herdr lifecycle transition is authoritative. | **Not true generally.** Herdr uses complete hooks for some agents and screen heuristics for others. | Preserve certainty/source; allow unknown. |
| Backend event streams can replay every missed event after reconnect or restart. | **Not proven.** Herdr directs clients to resnapshot; handoff can interrupt streams. | Snapshot/reconcile is mandatory. |
| Force termination kills all descendants on every supported platform. | **Not proven.** Process discovery can be incomplete and the Herdr shutdown path can exhaust its grace periods. | Confirmation must observe the bound incarnation and account for surviving descendants according to policy. |
| A native session resume restored the intended conversation before new writes. | **Not proven by launch alone.** Session metadata can be absent, stale, duplicated, or reported after startup. | Verify bound session identity before accepting work. |
| One host-local file lock provides cross-host single-writer safety. | **Not proven and generally false.** | Use a lease store whose consistency scope matches deployment scope. |
| Local socket/pipe reachability alone establishes caller authorization. | **Not established by the reviewed public contracts.** | Define endpoint permissions/authentication in deployment security design. |
| Windows has feature parity with Unix process observation and terminal control. | **False in Herdr 0.7.5 beta.** | Negotiate capabilities and test per platform. |

## Recommended protocol invariants

1. No command or observation applies without matching `(runId, incarnation)`.
2. No Agent Run starts writing until its session lease and fence are acquired.
3. No second run may hold the same session key concurrently.
4. No accepted input implies eventual success or completion.
5. No idle/settled/blocked observation implies process exit.
6. No missing/unavailable observation implies termination.
7. No resource-close acknowledgment implies termination.
8. Session lease release requires independently confirmed termination.
9. Observation gaps force resnapshot; they are never filled by assumption.
10. Adapter-private hosting details never enter the domain model.

## Sources and reproducibility

Primary sources reviewed completely where relevant:

- Installed Pi README and `docs/rpc.md`, `docs/json.md`, `docs/sdk.md`, `docs/session-format.md`, `docs/sessions.md`, `docs/extensions.md`, `docs/environment-variables.md`, and `docs/windows.md`; linked relevant session/RPC references were followed.
- Pi `0.82.0` source at tag commit `083e61621276bff9f6faefab87ce07fcd98734e2`.
- Herdr `0.7.5` README; agent automation, agents, integrations, CLI, socket API, persistence/remote, session-state, concepts, agent-skill, and Windows beta docs; bundled API schema; source at tag commit `ef4c23f5775bb8cfec05f05d0844226ff959a07a`.
- Executable help/probes from `pi --help`, `herdr --help`, relevant Herdr command groups, `herdr api schema --json`, and the two-writer Pi RPC probe described above.

[^pi-rpc-settled]: Pi, [`docs/rpc.md` lines 832–887](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/docs/rpc.md#L832-L887).
[^herdr-automation-model]: Herdr, [`agent-automation.mdx` lines 8–16](https://github.com/ogulcancelik/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/website/src/content/docs/agent-automation.mdx#L8-L16).
[^herdr-status-meaning]: Herdr, [`agent-automation.mdx` lines 76–80](https://github.com/ogulcancelik/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/website/src/content/docs/agent-automation.mdx#L76-L80).
[^herdr-wait-doc]: Herdr, [`socket-api.mdx` lines 95–120](https://github.com/ogulcancelik/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/website/src/content/docs/socket-api.mdx#L95-L120).
[^herdr-wait-source]: Herdr, [`src/api/wait.rs` lines 328–491](https://github.com/ogulcancelik/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/src/api/wait.rs#L328-L491).
[^herdr-process-info]: Herdr, [`socket-api.mdx` lines 196–199](https://github.com/ogulcancelik/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/website/src/content/docs/socket-api.mdx#L196-L199) and [`src/app/api/panes.rs` lines 193–240](https://github.com/ogulcancelik/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/src/app/api/panes.rs#L193-L240).
[^herdr-launch]: Herdr, [`agent-automation.mdx` lines 38–50](https://github.com/ogulcancelik/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/website/src/content/docs/agent-automation.mdx#L38-L50).
[^pi-rpc-state]: Pi, [`docs/rpc.md` lines 161–194](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/docs/rpc.md#L161-L194).
[^pi-rpc-client-start]: Pi, [`rpc-client.ts` lines 39–102](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/modes/rpc/rpc-client.ts#L39-L102).
[^pi-rpc-events]: Pi, [`docs/rpc.md` lines 828–887](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/docs/rpc.md#L828-L887).
[^herdr-snapshot]: Herdr, [`socket-api.mdx` lines 115–129](https://github.com/ogulcancelik/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/website/src/content/docs/socket-api.mdx#L115-L129).
[^herdr-handoff]: Herdr, [`session-state.mdx` lines 88–101](https://github.com/ogulcancelik/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/website/src/content/docs/session-state.mdx#L88-L101).
[^pi-rpc-framing]: Pi, [`docs/rpc.md` lines 3–37](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/docs/rpc.md#L3-L37).
[^pi-rpc-prompt]: Pi, [`docs/rpc.md` lines 41–78](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/docs/rpc.md#L41-L78).
[^pi-rpc-queue]: Pi, [`docs/rpc.md` lines 80–141](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/docs/rpc.md#L80-L141).
[^herdr-transport]: Herdr, [`socket-api.mdx` lines 602–641](https://github.com/ogulcancelik/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/website/src/content/docs/socket-api.mdx#L602-L641).
[^herdr-prompt-source]: Herdr, [`src/app/api/agents.rs` lines 58–105](https://github.com/ogulcancelik/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/src/app/api/agents.rs#L58-L105).
[^herdr-prompt-wait]: Herdr, [`agent-automation.mdx` line 76](https://github.com/ogulcancelik/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/website/src/content/docs/agent-automation.mdx#L76).
[^pi-abort-source]: Pi, [`agent-session.ts` lines 1540–1552](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/agent-session.ts#L1540-L1552).
[^pi-rpc-abort]: Pi, [`rpc-mode.ts` lines 389–438](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L389-L438).
[^herdr-keys]: Herdr, [`agent-automation.mdx` lines 64–74](https://github.com/ogulcancelik/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/website/src/content/docs/agent-automation.mdx#L64-L74) and [`src/app/api/agents.rs` lines 219–261](https://github.com/ogulcancelik/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/src/app/api/agents.rs#L219-L261).
[^herdr-windows]: Herdr, [`windows-beta.mdx` lines 90–112](https://github.com/ogulcancelik/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/website/src/content/docs/windows-beta.mdx#L90-L112).
[^herdr-shutdown-source]: Herdr, [`src/pane.rs` lines 1100–1188](https://github.com/ogulcancelik/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/src/pane.rs#L1100-L1188).
[^herdr-windows-kill]: Herdr, [`src/platform/windows.rs` lines 542–585](https://github.com/ogulcancelik/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/src/platform/windows.rs#L542-L585) and [`src/platform/linux.rs` lines 294–340](https://github.com/ogulcancelik/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/src/platform/linux.rs#L294-L340).
[^herdr-close-source]: Herdr, [`src/app/api/panes.rs` lines 1507–1575](https://github.com/ogulcancelik/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/src/app/api/panes.rs#L1507-L1575).
[^herdr-events]: Herdr, [`socket-api.mdx` lines 759–780](https://github.com/ogulcancelik/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/website/src/content/docs/socket-api.mdx#L759-L780).
[^pi-rpc-client-stop]: Pi, [`rpc-client.ts` lines 103–127](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/modes/rpc/rpc-client.ts#L103-L127).
[^pi-session-source]: Pi, [`session-manager.ts` lines 857–926 and 975–1048](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/session-manager.ts#L857-L1048).
[^herdr-session-reference]: Herdr, [`socket-api.mdx` lines 643–695](https://github.com/ogulcancelik/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/website/src/content/docs/socket-api.mdx#L643-L695).
[^herdr-session-restore]: Herdr, [`session-state.mdx` lines 49–84](https://github.com/ogulcancelik/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/website/src/content/docs/session-state.mdx#L49-L84).
[^herdr-authority]: Herdr, [`agents.mdx` lines 35–55](https://github.com/ogulcancelik/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/website/src/content/docs/agents.mdx#L35-L55).
[^pi-sdk-surface]: Pi, [`docs/sdk.md` lines 56–259](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/docs/sdk.md#L56-L259).
[^herdr-windows-process]: Herdr, [`windows-beta.mdx` lines 24–40](https://github.com/ogulcancelik/herdr/blob/ef4c23f5775bb8cfec05f05d0844226ff959a07a/website/src/content/docs/windows-beta.mdx#L24-L40).
[^pi-windows]: Pi, [`docs/windows.md` lines 1–17](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/docs/windows.md#L1-L17).
