# Pi transcript conformance source audit

**Target:** `@earendil-works/pi-coding-agent` 0.82.0

**Upstream revision:** [`083e61621276bff9f6faefab87ce07fcd98734e2`](https://github.com/earendil-works/pi/commit/083e61621276bff9f6faefab87ce07fcd98734e2) (`v0.82.0`)

**Prior decision:** [`research/pi-transcript-guarantees` at `1d6cbc8`](https://github.com/ewgdg/pi-agent-coordination/blob/1d6cbc8de66d6bf73e18a0ba82aba507c745b6eb/docs/research/pi-transcript-guarantees.md)

## Result

The requested conformance harness and the normal-restart branch marker can be implemented against the published packages with public SDK and extension seams. No Pi-core patch is required for [Prove Pi transcript commit and branch boundaries](https://github.com/ewgdg/pi-agent-coordination/issues/16).

The boundary is narrower than a general commit API:

- Pi has no extension event for “this arbitrary `message` or `custom_message` entry has now appended.” The next documented boundary (`tool_call`, `turn_end`, or a later context hook) must observe it.
- `pi.sendMessage()` is fire-and-forget and returns neither a promise nor an entry ID.
- tree navigation and the extension marker are two operations. They are reconstructable after the marker append returns, but not atomic across a crash between the leaf move and the marker.
- byte-level interruption inside `_persist()`, `fsync`, power-loss durability, and concurrent-writer safety remain outside extension conformance.

Those stronger requirements would need a Pi-core post-append/transactional storage seam or an external authoritative store. They are not part of the process-commit contract accepted in [Establish Pi transcript commit and branch guarantees](https://github.com/ewgdg/pi-agent-coordination/issues/2).

## Pin verification

The [npm registry manifest](https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/0.82.0) identifies 0.82.0 with `gitHead` `083e616…` and links the [published tarball](https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.82.0.tgz). The revision declares the same [package version](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/package.json#L1-L4), and its shrinkwrap fixes `pi-agent-core`, `pi-ai`, and `pi-tui` to [0.82.0](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/npm-shrinkwrap.json#L476-L518).

As an additional package/source check, the `sourcesContent` embedded in the 0.82.0 tarballs' source maps for `agent-session.ts`, `session-manager.ts`, and `agent-loop.ts` is byte-for-byte identical to those files at `083e616…`. The later supervisor throwaway uses 0.82.1; do not reuse that install or lock for this version-pinned test.

## Commit and event map

| Concern | Pinned code path | First useful observable boundary | Executable assertion |
|---|---|---|---|
| Assistant tool call | The agent awaits finalized assistant `message_end`, `AgentSession` runs extension handlers and SDK subscribers, then synchronously calls `appendMessage`; only after the awaited event drains does the loop inspect and prepare tool calls ([agent loop](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/agent/src/agent-loop.ts#L192-L224), [session persistence](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/agent-session.ts#L618-L643), [documented guarantee](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/docs/extensions.md#L751-L757)). | `tool_call` | The active branch and complete-LF file records contain the assistant entry and tool-call ID; the controlled tool's `execute` counter is still zero. `message_end` itself must show the assistant absent because it is pre-append. |
| Tool-result append and batching | `tool_result` finalizes the result, followed by `tool_execution_end`, then tool-result `message_start`/`message_end`. Parallel completion may interleave, but `Promise.all` restores assistant source order before result messages are emitted ([finalization](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/agent/src/agent-loop.ts#L709-L791), [parallel batching](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/agent/src/agent-loop.ts#L489-L548)). `turn_end` follows all result `message_end` events. | `turn_end` | No matching result entry exists at `tool_result`, `tool_execution_end`, or result `message_end`. At `turn_end`, every result exists once and in assistant source order, even when the tools were released in reverse order. |
| Model-visible custom delivery | Idle/no-trigger `sendCustomMessage` appends immediately. During streaming, `steer`/`followUp` only enqueue; `nextTurn` remains in memory until a later prompt. Queued messages append when the loop later emits their `message_end` ([delivery cases](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/agent-session.ts#L1417-L1463), [pending-message drain](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/agent/src/agent-loop.ts#L175-L190)). `custom_message` becomes an ordinary model-side user message containing only `content`; metadata is local ([conversion](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/messages.ts#L140-L168)). | The next `context` hook/provider call after queued delivery; branch observation for idle delivery | After `pi.sendMessage(..., { deliverAs: "steer" })` inside a streaming hook, the entry is absent. At the next provider context it is present on the active branch and the faux provider receives its content. After an idle send, a fresh `SessionManager.open()` sees it. |
| Full settlement | `_runAgentPrompt()` continues through retry, compaction, and queued continuations; only its `finally` flushes pending bash messages and emits settlement ([run loop](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/agent-session.ts#L1061-L1102)). `_emitAgentSettled()` clears active-run state before the awaited extension hook ([settlement](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/agent-session.ts#L581-L589)); the docs distinguish it from `agent_end` ([contract](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/docs/extensions.md#L558-L571)). | `agent_settled` | It occurs after the last `agent_end`, delivery/context observation, tool-result batch, retry/compaction event, and pending bash append. `ctx.isIdle()` is true unless another extension starts work from the hook. It proves quiescence, not another append or disk durability. |
| Compaction on a branch | `appendCompaction` parents the record to the current leaf. Manual and automatic paths append, rebuild agent context, then emit `session_compact` ([entry construction](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/session-manager.ts#L1096-L1118), [manual path](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/agent-session.ts#L1868-L1890)). Context reconstruction uses the latest compaction only on the active path; full entries remain available ([context builder](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/session-manager.ts#L410-L469)). | `session_compact` | `session_before_compact` sees no new compaction. `session_compact` sees it as the leaf, parented to the pre-compaction leaf, with rebuilt compacted context. `getBranch()` still contains full protocol entries, and a compaction on another branch does not affect this branch's context. |
| Tree navigation | Bare `branch()` and `resetLeaf()` change only in-memory `leafId` ([leaf move](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/session-manager.ts#L1354-L1374)). Navigation moves the leaf, optionally appends summary/label records, rebuilds context, then awaits `session_tree` ([navigation](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/agent-session.ts#L3014-L3073)). Reopen reconstructs the leaf as the last physical entry ([index rebuild](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/session-manager.ts#L958-L977)). | `session_tree`, but only in memory until an append | Navigate without summary or label and pause the `session_tree` handler before its marker. A fresh open still selects the old physical tail. Release the handler, append the marker, complete navigation, reopen, and observe the marker as leaf with the selected point as parent. |
| Branch marker | `pi.appendEntry()` synchronously calls `appendCustomEntry`, advances the leaf, then emits SDK-only `entry_appended` ([binding](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/agent-session.ts#L2381-L2386), [custom append](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/session-manager.ts#L1121-L1132)). Custom entries do not enter model context ([extension docs](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/docs/extensions.md#L1437-L1452)). | Return from `pi.appendEntry()` plus immediate `ctx.sessionManager` observation | In `session_tree`, save `event.newLeafId`, append a `wayfinder.branch-selection` custom entry containing that ID, then require the current leaf to be that custom entry and its `parentId` to equal the saved ID. After dispose/reopen, require the same marker leaf and branch path. |

For compaction, test the coding-agent implementation, not the broader format prose: 0.82.0's exported [`CompactionEntry`](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/src/core/session-manager.ts#L69-L80) has `firstKeptEntryId` and no `retainedTail`, although `session-format.md` also describes a [newer harness format](https://github.com/earendil-works/pi/blob/083e61621276bff9f6faefab87ce07fcd98734e2/packages/coding-agent/docs/session-format.md#L227-L246). The 0.82.0 conformance fixture must not synthesize or expect `retainedTail`.

## Recommended executable harness

Use Node's built-in test runner against exact `0.82.0` dependencies in an isolated temporary project. Do not import Pi repository test helpers or source paths: this must exercise the published package.

Build the fixture only from public seams:

- `createAgentSession`, `SessionManager.create/open`, `DefaultResourceLoader`, `ModelRuntime`, `defineTool`, and SDK `session.subscribe()` from `@earendil-works/pi-coding-agent`;
- the published deterministic faux provider from `@earendil-works/pi-ai/providers/faux` registered through `ModelRuntime.registerNativeProvider()`;
- an inline extension loaded through `DefaultResourceLoader.extensionFactories`;
- two custom tools controlled by explicit promises, so the test releases the second tool before the first without timing sleeps;
- a persisted session directory created under the OS temporary directory.

At every relevant hook, record one compact snapshot:

```text
event, leafId, active-branch entry IDs/types/roles, complete-LF JSONL records, tool execution counters
```

Use four focused cases:

1. **Tool commit order:** one faux assistant response calls two tools; release them in reverse order; a second response ends the run. Assert every row in the tool-call/result/turn boundary above.
2. **Custom delivery and settlement:** enqueue a correlated custom message from the first `tool_call`; assert absence at enqueue, presence at the next provider context, receipt by the faux provider, and final `agent_settled` ordering. Separately send once while idle and reopen the file.
3. **Compaction branch:** create enough persisted history for `prepareCompaction`, create two branches, and have `session_before_compact` return a deterministic summary so no network summarizer runs. Assert pre/post append, active-path context, and full-branch reconstruction.
4. **Tree marker restart:** navigate to a non-user entry with `summarize: false` and no label. Block inside `session_tree`, fresh-open before the marker as the control, then append and validate the marker, dispose, and fresh-open again. This proves the exact memory-only and restart-reconstructable boundaries without killing a process.

Each failure should print the snapshot trace and the installed package versions. Run the suite as an upgrade gate: source-proven ordering is pinned behavior, not a promise for future Pi releases.

## Core-change decision

| Capability | Extension/package harness | Pi core needed |
|---|---:|---:|
| Assert assistant append before execution | Yes | No |
| Assert complete tool-result batch | Yes, at `turn_end` | No |
| Assert queued `custom_message` delivery | Yes, at later context/branch observation | No |
| Assert quiescence, compaction, navigation, and normal-restart marker | Yes | No |
| Receive exact post-append event/entry ID for every ordinary message | No | Yes |
| Await a `sendMessage()` delivery receipt | No | Yes |
| Acknowledge each tool result immediately after its individual append | No; only the post-batch hook exists | Yes |
| Make navigation and marker one crash-atomic operation | No | Yes, or external transactional storage |
| Inject a crash at a byte offset inside Pi persistence | No | Yes, a core storage test seam |
| Establish stable-storage or multi-writer guarantees | No | Yes, a different Pi storage contract or external authoritative store |
