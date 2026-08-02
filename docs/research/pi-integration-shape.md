# Required Pi integration shape

**Question:** Which public and private structural and behavioral seams must a running Pi host expose for the coordination package to compose coherently?

**Decision ticket:** [Define the required Pi integration shape](https://github.com/ewgdg/pi-agent-coordination/issues/21)

## Verdict

Compatibility is defined by the **host integration shape**, not by Pi's version string.

The package must not compare `VERSION` for admission. A host is compatible when:

1. every required public and private member exists with the expected callable/data shape;
2. the members belong to the running host module world rather than a separately installed Pi copy;
3. startup ordering permits the bridge to capture the host runtime before native interactive binding completes; and
4. the behavioral conformance suite passes for transcript ordering, Human Request serialization, native rebinding, settlement, interruption, viewport reconstruction, and coordinated disposal.

`VERSION` may appear in diagnostics and test output, but it is neither an allowlist nor a rejection condition.

Shape checks establish structural compatibility. The conformance suite establishes semantics that names and TypeScript signatures alone cannot prove.

## Package compatibility rule

Pi provides its core modules to loaded extensions. The package must follow Pi's normal package contract:

```json
{
  "peerDependencies": {
    "@earendil-works/pi-agent-core": "*",
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  }
}
```

Only packages actually imported need to be declared. Pi packages remain absent from runtime `dependencies` and `bundledDependencies`.

This follows Pi's [package guidance](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/docs/packages.md#dependencies). The extension loader aliases Pi imports to modules owned by the running host ([loader aliases](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/extensions/loader.ts#L74-L137)), and managed installation disables peer auto-installation because the host supplies those modules ([installer behavior](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/package-manager.ts#L1775-L1795)).

Development dependencies and lockfiles may select concrete package versions so a test run is reproducible. Those selections are test fixtures, not runtime compatibility declarations.

## Host-module ownership

The integration bridge must resolve the package owning the running CLI and use that host's exported constructors, sessions, runtime, and TUI values. It must not patch or create sessions through a package-local SDK copy.

The accepted adapter demonstrates host resolution from the CLI entry point and child creation through the resolved host SDK:

- [host module resolution](https://github.com/ewgdg/pi-agent-coordination/blob/54ed6c3df863c5b85e475178bb0cb746301092de/prototypes/sdk-agent-supervisor-inprocess/runtime-capture.ts#L95-L117)
- [host-owned child session creation](https://github.com/ewgdg/pi-agent-coordination/blob/54ed6c3df863c5b85e475178bb0cb746301092de/prototypes/sdk-agent-supervisor-inprocess/supervisor-coordinator.ts#L181-L229)

The production bridge keeps the host-resolution approach but replaces the prototype's version comparison with the structural preflight below.

## Structural preflight

Run this preflight synchronously before creating a coordinator, child session, lane, timer, or presentation surface and before installing any patch. A missing or malformed member is a startup error.

### Host exports

The host entry point must expose:

- `AgentSessionRuntime` as a constructor;
- `InteractiveMode` as a constructor;
- `createAgentSessionServices` as a function;
- `createAgentSessionFromServices` as a function;
- `SessionManager` with the creation, opening, lookup, branch, and append operations used by transcript ownership;
- `DefaultResourceLoader` or the corresponding host resource-loader constructor;
- the extension and tool registration surfaces needed by hidden role-bound extensions; and
- the public TUI/component values used by presentation.

These SDK factories are public in the audited host source ([session services](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/agent-session-services.ts#L37-L79), [SDK exports](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/index.ts#L194-L221)).

### Runtime prototype and instance

`AgentSessionRuntime.prototype` must expose callable:

- `setRebindSession`;
- `setBeforeSessionInvalidate`; and
- `dispose`.

A captured runtime instance must expose public semantic getters for `session`, `services`, `diagnostics`, and `modelFallbackMessage`, plus the writable host-selection slots and callbacks required by the bridge:

- `_session`;
- `_services`;
- `_diagnostics`;
- `_modelFallbackMessage`;
- `rebindSession`; and
- `beforeSessionInvalidate`.

The private fields and callbacks are visible in the audited runtime shape ([source](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/agent-session-runtime.ts#L67-L130)).

### Interactive mode prototype and instance

`InteractiveMode.prototype` must expose callable:

- `bindCurrentSessionExtensions`;
- `rebindCurrentSession`; and
- `getUserInput`.

A live mode instance must expose:

- its selected host runtime/session relation;
- `ui.requestRender(force)`;
- working-indicator synchronization operations;
- native session-state reconstruction through `rebindCurrentSession`; and
- the normal error-reporting path used when continuously dispatched input fails.

The audited native constructor registers runtime invalidation and rebind callbacks ([source](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L434-L457)). Native rebinding must continue to rebuild session presentation, bind extensions, resubscribe, and refresh footer/title state ([source](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L1632-L1765)).

### Agent session

Every hosted `AgentSession` must expose callable:

- `prompt` and the accepted structured custom-message delivery operation;
- `subscribe`;
- `bindExtensions`;
- `abort`;
- `waitForIdle`; and
- `dispose`.

For retained native selection, the session must also expose the extension runner plus the private host-binding fields and `_applyExtensionBindings` operation needed to refresh TUI callbacks without replaying `session_start` ([binding source](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/agent-session.ts#L2229-L2252), [refresh implementation](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/agent-session.ts#L2307-L2315)).

### Tool definition

The host tool definition must accept `executionMode: "sequential"`, pass an `AbortSignal` to `execute`, turn a rejected execution into an error tool result, and stop a sequential batch before later siblings once aborted.

The audited shape and routing are public ([tool definition](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/extensions/types.ts#L443-L480), [sequential routing](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/agent/src/agent-loop.ts#L411-L488), [error finalization](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/agent/src/agent-loop.ts#L666-L753)).

## Behavioral contract

Structural checks are necessary but insufficient. A compatible host must pass these observable contracts.

| Concern | Required behavior |
|---|---|
| Transcript commit | The assistant tool-call entry is process-committed before tool execution. Tool-result hooks precede their own append; `turn_end` observes the complete source-ordered result batch. |
| Coordination delivery | Streaming Steer admission is memory-only until the next safe model boundary; committed recipient transcript evidence is model-visible and excludes local-only details. Idle delivery survives reopen. |
| Settlement | `agent_settled` occurs only after retries, compaction recovery, queued continuations, and tool-result commits have drained. `waitForIdle()` resolves after that boundary. |
| Compaction and branches | Compaction is post-append, post-context-rebuild, and branch-scoped. A bare branch move is memory-only; appending a non-model marker makes the selected branch reconstructable after reopen. |
| In-process hosting | Multiple host-created `AgentSession`s can remain live concurrently; deselection neither aborts nor disposes a session. |
| Human Request barrier | A sequential `ask_user_question` blocks later sibling tool calls. A successful Answer tool result commits before the next sibling starts. |
| Interruption | Aborting a blocked Human Request produces its matching `isError: true` tool result, prevents later sibling execution, and resolves only after settlement. |
| Native rebinding | Owner→child→Owner selection uses native transcript, editor, queues, tools, history, Vim behavior, working state, and footer without stopping deselected work. |
| Extension refresh | First bind emits one `session_start`; reselection refreshes host UI bindings without replaying session lifecycle. |
| Continuous input | An idle selected session accepts editor input while a deselected session remains active. |
| Viewport reconstruction | Switching from a longer to a shorter retained transcript performs a full native render and leaves the selected editor/footer at the live terminal bottom. |
| Disposal | Repeated or racing shutdown requests pass through one memoized host owner; every selected or retained session receives one shutdown/dispose sequence. |

Pi's native `AgentSessionRuntime.dispose()` is not idempotent; coordinated exactly-once disposal remains an adapter-owned guarantee ([native source](https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/agent-session-runtime.ts#L395-L402), [accepted memoized adapter](https://github.com/ewgdg/pi-agent-coordination/blob/54ed6c3df863c5b85e475178bb0cb746301092de/prototypes/sdk-agent-supervisor-inprocess/pi-runtime-selection.ts#L42-L57)).

## Evidence

The audited published Pi cohort is an executable exemplar of this shape, not an allowlisted version:

- the published-package transcript harness passed all 12 commit, delivery, settlement, compaction, and branch checks;
- the accepted in-process multiplexer passed all 21 tests and strict typechecking;
- a supplemental published-package probe confirmed sequential Human Request success and interruption behavior; and
- the accepted real-terminal exercise confirmed native retained-session interaction and rendering.

Primary artifacts:

- [Transcript conformance harness](https://github.com/ewgdg/pi-agent-coordination/tree/89384011d96b3511e1680fbfebb549279a80d220/prototypes/pi-transcript-conformance)
- [Transcript source audit](https://github.com/ewgdg/pi-agent-coordination/blob/89384011d96b3511e1680fbfebb549279a80d220/docs/research/pi-conformance-source-audit.md)
- [In-process host adapter and tests](https://github.com/ewgdg/pi-agent-coordination/tree/54ed6c3df863c5b85e475178bb0cb746301092de/prototypes/sdk-agent-supervisor-inprocess)
- [Accepted host prototype report](https://github.com/ewgdg/pi-agent-coordination/blob/54ed6c3df863c5b85e475178bb0cb746301092de/docs/sdk-agent-supervisor-inprocess-prototype.md)

## Conformance gate

The package's CI must run against the concrete host dependency graph selected for that test job. At minimum it covers:

1. all transcript commit and branch assertions;
2. runtime capture before first native binding;
3. Owner→child→Owner selection without disposal or abort;
4. deselected streaming plus selected idle input;
5. one startup event per session and binding-only refresh on reselection;
6. successful and interrupted sequential Human Requests;
7. settled interruption;
8. long→short viewport reconstruction;
9. repeated and racing shutdown; and
10. structural rejection fixtures with each required member absent or malformed.

A host version may be added to the CI matrix to discover shape drift, but no version enters the runtime contract. Passing structure and behavior is what matters.

## Failure behavior

Structural preflight is fail-fast and all-or-nothing:

- report the missing or malformed seam by canonical member name;
- include the observed host version only as diagnostic context when available;
- install no partial monkeypatches;
- start no coordination runtime or presentation; and
- do not fall back to a reduced or projection-based mode.

Unexpected semantic failure after admission is an integration invariant failure. Fence new work, preserve transcript evidence, and use the existing coordinated shutdown path rather than silently continuing under an unverified host.

## Limits

The host shape does not add guarantees Pi does not expose:

- no stable-storage, `fsync`, power-loss, repair, or concurrent-writer guarantee;
- no generic immediate post-append receipt for every model-visible entry;
- no atomic tree-move-plus-marker operation;
- no exactly-once model reasoning, tool execution, or external side effect;
- no print, JSON, or RPC presentation support; and
- no semantic proof from runtime reflection alone—the behavioral gate remains mandatory.

## Decision

Support the required Pi integration **shape**. Use host-provided peer modules, resolve and patch the running host module world, structurally verify every public and private seam before startup, and retain the full behavioral conformance suite as the semantic contract. Pi's version string is diagnostic metadata only.
