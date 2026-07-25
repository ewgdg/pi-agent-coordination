# Pi transcript commit and branch guarantees

**Status:** resolved for `@earendil-works/pi-coding-agent` 0.82.0

**Research date:** 2026-07-25

**Upstream revision:** [`083e61621276bff9f6faefab87ce07fcd98734e2`](https://github.com/earendil-works/pi/commit/083e61621276bff9f6faefab87ce07fcd98734e2) (`npm` package `gitHead` for 0.82.0)

## Decision

Wayfinder may use Pi's transcript as a **single-writer, process-commit log**, not as a crash-durable or concurrently writable WAL.

The useful commit boundaries are:

- an assistant tool-calling message is in `SessionManager` and has completed Pi's synchronous file append before `tool_call` runs;
- all tool-result messages for an assistant turn have completed their synchronous appends before `turn_end` runs;
- no automatic retry, compaction retry, or queued continuation remains at `agent_settled`;
- a compaction entry has been appended and context rebuilt before `session_compact`;
- tree state has changed before `session_tree`, but a bare no-summary/no-label tree navigation is **memory-only until another entry is appended**.

“Completed append” above is deliberately narrower than “durable”: Pi uses synchronous writes and closes files, but does not `fsync`, lock session files, atomically replace rewrites, checksum records, or expose an extension acknowledgment for every message append. Power-loss durability, multi-process writer safety, and atomic record visibility are not established.

For coordination:

1. keep exactly one Pi process as transcript writer;
2. make protocol entries idempotent and reconstruct state from `getBranch()`, not physical line order alone;
3. acknowledge assistant calls no earlier than `tool_call`, tool-result batches no earlier than `turn_end`, and complete runs no earlier than `agent_settled`;
4. append a non-model-visible protocol marker from `session_tree` when durable reconstruction of the selected leaf matters;
5. do not treat queued `sendMessage()` delivery as committed until its `custom_message` entry is observed;
6. use owner-process IPC/RPC for live reads. If direct JSONL reads are unavoidable, accept only complete LF-terminated records, retain an incomplete suffix, reopen on each poll, and halt on malformed links or duplicate IDs.

## Evidence standard and scope

Labels used below:

- **Documented guarantee** — stated by Pi's installed documentation at the pinned revision.
- **Source-proven behavior** — directly follows from the 0.82.0 implementation, but is not necessarily a promised stable API.
- **Observed** — reproduced against the installed 0.82.0 package. An observation does not create a durability guarantee.
- **Unknown** — neither documentation nor source establishes the property.

The relevant installed Markdown was read completely: the package README and `docs/extensions.md`, `session-format.md`, `sessions.md`, `compaction.md`, `environment-variables.md`, `sdk.md`, `json.md`, and `rpc.md`, including their relevant cross-references. Source conclusions are pinned to the package's exact revision rather than current `main`.

## Guarantee matrix

| Concern | What Wayfinder can rely on | Classification | What it must not infer |
|---|---|---|---|
| Assistant tool-call persistence | `tool_call` runs only after prior Agent events have drained, so `ctx.sessionManager` includes the finalized assistant message containing the tool call. Pi has synchronously appended that message before the loop starts tool execution. | Documented + source-proven | Streaming `message_update` content is not persisted. `message_end` itself is pre-append. A completed append is not an `fsync` durability boundary. |
| Tool-result persistence | `tool_result` can modify the final result; `tool_execution_end` follows it. Final `toolResult` message events are emitted in assistant source order; their `message_end` processing appends them. `turn_end` follows all results in that batch. | Documented + source-proven | Neither `tool_result` nor `tool_execution_end` means the result entry has been appended. In parallel mode, sibling results are unavailable during preflight and completion hooks may interleave. |
| Custom model-visible delivery | `pi.sendMessage()` creates `custom_message`; content is converted to a user message for the model, while `details` is not sent. `before_agent_start` may also inject a persistent custom message. | Documented + source-proven | A streaming `steer`, `followUp`, or `nextTurn` queue insertion is not persistence. `display: false` hides UI only; it does not hide content from the model. |
| Extension-only state | `pi.appendEntry()` creates a `custom` entry that is excluded from model context and can be replayed from session entries. | Documented + source-proven | It provides no returned entry ID or general extension post-append event. It is not a filesystem durability acknowledgment. |
| Active branch reconstruction | In-process, `getBranch()` follows `parentId` from the current leaf. After an append on a selected branch, reopening chooses the physically last parsed entry as leaf and reconstructs through its parents. | Source-proven + observed | The selected leaf is not stored separately. A bare `branch()`/`resetLeaf()` or `/tree` navigation with no appended summary/label is lost on reopen until a later entry records that parent. |
| Compaction | Full entries stay in the append-only file. The latest compaction on the active path supplies a summary plus entries from `firstKeptEntryId`, followed by post-compaction entries. `session_compact` is post-append and post-context-rebuild. | Documented + source-proven | Compaction is lossy model context, not deletion. Current coding-agent `SessionManager` does not implement the documented newer-harness `retainedTail` checkpoint behavior. |
| Branching/forking | `/tree` changes the in-file tree; `/fork` and `/clone` create a new file containing one active path. `session_before_tree`/`session_before_fork` are pre-events; `session_tree`/new-session `session_start` are post-transition hooks. | Documented + source-proven | `parentSession` is provenance, not transaction linkage. A fork file is written with ordinary synchronous writes and no `fsync`/atomic publish protocol. |
| Partial JSONL writes | The loader skips malformed lines and will parse a valid final record even without LF. | Source-proven + observed | Pi does not repair or quarantine an incomplete suffix. A later append concatenates onto it, losing that next record to parsing and potentially creating orphaned descendants. |
| Cross-process reads | A newly opened reader sees completed writes visible through the filesystem. The owner process's RPC `get_entries` exposes append order and current in-memory `leafId`; docs describe entry IDs as restart-stable cursors. | Documented for RPC; observed for fresh file opens | An already-open `SessionManager` does not refresh. A racing file reader has no snapshot/record-atomicity guarantee. Direct file reads do not see an unpersisted in-memory leaf move. |
| Append ordering | Within one owner process, awaited event dispatch plus synchronous appends gives the order detailed below. | Source-proven | There is no documented multi-writer serialization, lock, CAS, transaction, checksum, or exactly-once delivery guarantee. |

## Exact message and tool ordering

The low-level loop awaits the finalized assistant `message_end` before it inspects tool calls and starts execution ([agent loop, lines 192–224](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/agent/src/agent-loop.ts#L192-L224)). `AgentSession` then performs this order for each event:

1. await extension event handlers;
2. notify `AgentSession` subscribers;
3. on `message_end`, append the custom or regular message through `SessionManager` ([agent-session, lines 618–643](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/agent-session.ts#L618-L643)).

Consequences:

- **`message_end` is before persistence.** It may replace the finalized message, and that replacement is what later gets appended ([agent-session, lines 695–765](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/agent-session.ts#L695-L765)). The same is true for SDK/JSON/RPC `message_end` subscribers because notification precedes persistence.
- **`tool_call` is after assistant persistence.** This is explicit in the extension docs: `ctx.sessionManager` is synchronized through the current assistant tool-calling message before the hook ([extensions, lines 751–757](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/docs/extensions.md#L751-L757)). Because the append is synchronous, source execution cannot advance to tool preflight until it returns.
- **`tool_result` and `tool_execution_end` are before result persistence.** The result hook runs while finalizing the tool; then `tool_execution_end`; then a `toolResult` message's start/end events ([agent loop, lines 710–791](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/agent/src/agent-loop.ts#L710-L791)).
- **`turn_end` is after result persistence.** The result `message_end` events are awaited before `turn_end` ([agent loop, lines 202–224](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/agent/src/agent-loop.ts#L202-L224)). Thus it is the first extension hook that sees the complete persisted batch.
- **Parallel result append order is assistant source order, not completion order.** Parallel executions finalize and emit `tool_execution_end` as they complete; `Promise.all` restores array order, after which result message events are emitted sequentially ([agent loop, lines 489–548](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/agent/src/agent-loop.ts#L489-L548)). A crash can therefore leave the assistant call plus a prefix of source-ordered results even though later siblings already caused side effects.
- **`agent_end` is not full settlement.** Pi may retry, compact and retry, or process queued continuations. The docs reserve `agent_settled` for “no retry/compaction/follow-up left” ([extensions, lines 558–571](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/docs/extensions.md#L558-L571)); pending direct bash messages are flushed before Pi emits it ([agent-session, lines 1061–1072](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/agent-session.ts#L1061-L1072)).

### Hook table

| Hook | Session/file state when handler starts | Suitable protocol use |
|---|---|---|
| `message_end` | Current finalized message not yet appended | Transform same-role message only; not acknowledgment |
| `tool_call` | Assistant call entry appended; no sibling results guaranteed | Record/authorize dispatch |
| `tool_result` | Tool finished; final result patchable; result entry absent | Patch result/details |
| `tool_execution_end` | Final result known; result entry still absent | UI/metrics, not commit |
| `turn_end` | Assistant and all source-ordered result entries appended | Commit/acknowledge the batch |
| `agent_end` | Current low-level run appended; continuation may follow | Per-run telemetry only |
| `agent_settled` | Pending direct bash flushed; no automatic continuation | Whole-run quiescence |
| `session_before_compact` | No new compaction entry | Cancel or supply summary |
| `session_compact` | Compaction entry appended; context rebuilt | Post-compaction checkpoint |
| `session_before_tree` | Old leaf active | Validate/cancel transition |
| `session_tree` | New in-memory leaf active; optional summary/label already appended | Append a protocol leaf marker and then acknowledge navigation |
| `session_before_fork` | Old session active, new file absent | Validate/cancel fork |
| replacement `session_start` | New session runtime rebound | Rebuild extension state from the new branch |

There is **no generic extension event meaning “this arbitrary message/custom entry has just been appended.”** `pi.appendEntry()` calls `appendCustomEntry` synchronously in this version, but its public return type is `void`; the internal `entry_appended` event is emitted to `AgentSession` listeners, not through the documented extension event set ([agent-session, lines 2361–2386](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/agent-session.ts#L2361-L2386)).

## Custom delivery semantics

Pi documents two distinct extension records:

- `custom_message`, from `pi.sendMessage()`, participates in model context;
- `custom`, from `pi.appendEntry()`, persists extension state but is excluded from model context ([extensions, lines 1386–1449](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/docs/extensions.md#L1386-L1449)).

A custom message is converted to an ordinary model-side user message containing only `content`; `customType`, `display`, and `details` are not sent to the provider ([messages, lines 140–168](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/messages.ts#L140-L168)). Therefore:

- `display: false` is suitable for hidden model-visible protocol delivery;
- `details` is suitable for local correlation metadata, but the model cannot inspect it;
- put any correlation value the model must use in `content` as well.

Delivery timing is important. At idle with no triggered turn, `sendCustomMessage` appends immediately. During streaming, `steer` and `followUp` only enqueue in memory; `nextTurn` is also kept in memory until the next user prompt ([agent-session, lines 1420–1462](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/agent-session.ts#L1420-L1462)). The public `pi.sendMessage()` wrapper is fire-and-forget and catches the returned promise rather than returning it ([agent-session, lines 2361–2371](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/agent-session.ts#L2361-L2371)). Queue acceptance is therefore not a persistence acknowledgment, and an undelivered queued message is lost on process exit.

For exactly-once *effects*, use an application delivery ID in both custom-message content and details, persist processed IDs in branch-scoped state, and make consumption idempotent. Pi itself guarantees neither exactly-once enqueue nor exactly-once external side effects.

## Tree, leaf, fork, and reconstruction

Entries form an append-only tree. Each append uses the current in-memory leaf as `parentId`, then advances the leaf ([session manager, lines 1044–1066](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/session-manager.ts#L1044-L1066)). `getBranch()` walks parent links from that leaf ([session manager, lines 1255–1285](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/session-manager.ts#L1255-L1285)).

The critical limitation is that the leaf pointer has no separate on-disk record. On load, `_buildIndex()` sets leaf to each parsed entry in physical order, leaving the last parsed entry active ([session manager, lines 958–977](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/session-manager.ts#L958-L977)). `branch()` and `resetLeaf()` only mutate memory ([session manager, lines 1354–1374](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/session-manager.ts#L1354-L1374)).

As a result:

- moving with `/tree` and then quitting before any append reopens the old physical tail, not the selected point;
- appending any entry after navigation records the selected parent and makes that new entry the physical tail;
- a branch summary already does this because it appends `branch_summary` at the new position;
- a Wayfinder `custom` marker appended during `session_tree` is the smallest non-model-visible way to persist the selected branch.

`session_tree` is emitted after leaf mutation, optional summary/label append, and context rebuild ([agent-session, lines 3014–3073](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/agent-session.ts#L3014-L3073)). There remains a process-crash window between core mutation and the extension's marker append; Wayfinder must not acknowledge navigation until its marker call returns and is observable in `ctx.sessionManager`.

Fork/clone extracts one root-to-leaf path to a new file and re-chains around removed label entries ([session manager, lines 1412–1488](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/session-manager.ts#L1412-L1488)). This preserves entry IDs on the copied path and records `parentSession` in the new header. It does not create a live relationship between files.

## Compaction guarantees and documentation mismatch

Pi's user-facing contract is that compaction is lossy for model context while full history remains in JSONL. In the coding-agent 0.82.0 source, `buildContextEntries()`:

1. follows the active leaf path;
2. chooses the latest compaction on that path;
3. emits the compaction summary;
4. emits pre-compaction entries beginning at `firstKeptEntryId`;
5. emits post-compaction entries ([session manager, lines 410–469](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/session-manager.ts#L410-L469)).

Manual and automatic compaction both call `appendCompaction`, rebuild agent context, and only then emit `session_compact` ([agent-session, lines 1868–1890](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/agent-session.ts#L1868-L1890)). This is a usable process-level post-commit hook.

The installed `session-format.md` also describes newer harness-generated compactions with embedded `retainedTail` ([session-format, lines 232–243](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/docs/session-format.md#L232-L243)). That is **not implemented by this version's coding-agent `SessionManager`**: its `CompactionEntry` has `firstKeptEntryId` but no `retainedTail`, and its context builder never reads such a field ([session manager, lines 47–59](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/session-manager.ts#L47-L59), [lines 410–469](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/session-manager.ts#L410-L469)). Wayfinder must feature-detect the actual exported entry type/runtime and must not assume self-contained `retainedTail` checkpoints for 0.82.0.

Protocol state that must survive compaction should live in branch-linked `custom` entries or tool-result `details` and be reconstructed from `getBranch()`. Do not reconstruct only from `buildContextEntries()`, which intentionally omits summarized history.

## JSONL writes, partial records, and durability

### What the implementation does

`SessionManager` mutates its in-memory arrays first and then writes synchronously. For an established file it calls `appendFileSync(path, JSON.stringify(entry) + "\n")`. Initial materialization is delayed until an assistant message exists; Pi then creates the file with `"wx"` and writes all accumulated entries. Rewrites truncate with `"w"` and write entries directly ([session manager, lines 979–1048](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/session-manager.ts#L979-L1048)).

This establishes only program-order completion in the owner process. The source has no session-file lock, `fsync`/`fdatasync`, temp-file-plus-rename rewrite, checksum, length prefix, or recovery journal. Accordingly:

- before the first assistant response, `getSessionFile()`/`PI_SESSION_FILE` may name a file that does not yet exist;
- a successful append method return means the synchronous Node write call and close returned;
- it does not prove stable-storage persistence after OS crash or power loss;
- rewrite/migration interruption can damage the whole file;
- concurrent writers are outside any established guarantee.

### Loader behavior under partial writes

The loader reads chunks, splits on LF, and also attempts to parse a final non-LF suffix. Any malformed line is silently skipped ([session manager, lines 503–546](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/session-manager.ts#L503-L546)). This is tolerant, not transactional recovery.

If a process leaves an invalid partial JSON suffix, the next append adds its JSON immediately after that suffix. Both byte sequences become one malformed physical line and are skipped together. A later valid entry can parse but point to the skipped entry, making it an orphan; `getTree()` explicitly exposes broken-parent entries as roots ([session manager, lines 1296–1334](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/session-manager.ts#L1296-L1334)). Pi does not truncate back to the last valid LF.

A direct-file consumer should therefore use LF—not successful `JSON.parse` of an unterminated suffix—as its commit delimiter, preserve and retry the suffix, and validate IDs/parents itself. This consumer rule protects against observing an in-progress write; it cannot create crash durability Pi does not provide.

## Cross-process read and writer rules

An existing `SessionManager` is a loaded snapshot; there is no refresh/tail method. A fresh `SessionManager.open()` rereads the file. The installed docs explicitly allow inspecting `PI_SESSION_FILE` directly, but do not promise a coherent concurrent snapshot ([environment variables, lines 23–40](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/docs/environment-variables.md#L23-L40)).

RPC is stronger for live coordination because it queries the owner process. `get_entries` returns append order and in-memory `leafId`, and its docs call stable entry IDs durable cursors across client restarts ([RPC, lines 692–723](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/docs/rpc.md#L692-L723)). Interpret “durable cursor” under normal successful session persistence, not as a claim of `fsync` or corruption recovery.

Wayfinder should never open a second writable `SessionManager` on the active file. Two managers can hold stale leaves and append mutually unaware children; no lock serializes semantic parent choice. Even if an operating system happens to append each small write contiguously, that would not solve stale branch state and is not a Pi guarantee.

## Executed probes

Two dependency-free Node probes exercised the installed 0.82.0 `SessionManager` in disposable directories. The probes used only public/deep-exported runtime methods and direct file appends; no product code was added.

Observed:

1. after a first user append, the named session file did not exist; after the first assistant append, it contained header + user + assistant;
2. `custom` appeared on `getBranch()` but not in model messages; `custom_message` appeared as role `custom`;
3. after branching and appending a child, a fresh open selected that child and reconstructed the selected parent path;
4. an already-open reader remained at 5 entries after another manager appended, while a fresh reader saw 6;
5. a malformed suffix was skipped; appending one valid entry after it concatenated the bytes and caused that valid entry to be skipped too;
6. branching without append changed the in-memory leaf, but a fresh open still selected the old physical tail; after a marker append, a fresh open selected the marker whose parent was the chosen branch point.

These observations confirm the source interpretation. They do **not** establish behavior under kill/power loss, filesystem-specific atomicity, or concurrent writers.

## Smallest remaining prototypes

These are conformance/risk probes, not missing research that blocks the decision above.

### P0 — fake-provider hook snapshot test

Build one test-only extension and deterministic fake stream producing an assistant message with two parallel tools. At every relevant hook, capture:

- event name;
- `ctx.sessionManager.getLeafId()` and branch entry roles;
- complete LF-terminated records visible from a fresh file descriptor.

Assert assistant visibility at `tool_call`, result absence at `tool_result`/`tool_execution_end`, source-ordered result visibility at `turn_end`, and final quiescence at `agent_settled`. Run this whenever Pi is upgraded because most ordering conclusions are implementation-level.

### P0 — tree marker restart test

Drive `navigateTree()` without summary, append the Wayfinder branch marker from `session_tree`, terminate, reopen, and assert the marker is the leaf and has the selected parent. Also terminate immediately before the marker to verify Wayfinder withholds its navigation acknowledgment.

### P1 — crash fault injection only if transcript durability is required

Wrap or instrument the session writer to stop after selected byte counts during initial flush, append, compaction append, fork creation, and rewrite; then `SIGKILL`, reopen, and classify outcomes. A stress probe cannot prove durability. If product requirements include power-loss-safe commits, the answer is not “probe until confident”: add a Wayfinder-owned WAL/database with explicit flush semantics and treat Pi JSONL as a projection.

No concurrent-writer prototype is recommended. The source already lacks coordination; design it out rather than trying to certify incidental filesystem behavior.

## Unproven and explicitly rejected assumptions

The following remain unknown or false as guarantees and must not enter the protocol contract:

- stable-storage durability after a synchronous append returns;
- record atomicity for a reader racing a writer, on every supported OS/filesystem and entry size;
- safety of two writers against the same session file;
- recovery of an incomplete final record or atomic migration/rewrite;
- persistence of a leaf move that has no subsequent appended entry;
- persistence of queued `steer`, `followUp`, or `nextTurn` custom messages before delivery;
- a generic post-append extension hook for every message or custom entry;
- exactly-once model-visible delivery or exactly-once tool side effects;
- `retainedTail` compaction support in coding-agent 0.82.0;
- future Pi versions preserving source-proven ordering that is not explicitly documented.

## Practical protocol contract

The smallest safe Wayfinder contract on Pi 0.82.0 is:

- **Call accepted:** at `tool_call`, keyed by assistant entry ID/tool-call ID; record an idempotent protocol state entry.
- **Result committed:** at `turn_end`, after locating each corresponding `toolResult` entry on the active branch.
- **Run settled:** at `agent_settled`; this is quiescence, not disk durability.
- **Delivery committed:** only when the target `custom_message` entry is present on the intended active branch, never when `sendMessage()` merely queues it.
- **Branch committed:** append a Wayfinder `custom` branch marker after `session_tree`; acknowledge only after observing it as current leaf.
- **Compaction committed:** at `session_compact`; reconstruct protocol state from full active `getBranch()`, not compacted model context.
- **External reader:** query the owner process where possible. Otherwise tail complete LF records with validation and no writer privileges.
- **Durability:** if loss on kernel/host failure is unacceptable, keep authoritative coordination state outside Pi's transcript.
