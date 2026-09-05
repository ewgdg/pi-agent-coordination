# Transcript facts and incremental consumption

Pi transcripts remain the durable authority. An Agent's transcript adapter retains
physical entries and disposable indexes in memory. Loaded child Identity and
`creationInput` are trusted records. Creation Request lookup derives and retains
its Request from those fields without inspecting the Spawner again. Cold discovery
reads the referenced source once to obtain the required spawn input; missing or
unreadable required input prevents admission.

## Ownership and observations

One adapter owns physical consumption, entry positions, identity cutoffs, source
and result buckets, Delivery indexes, parsed Request sources, Answer Retrievals,
and model/thinking metadata. Protocol projections use that state rather than
keeping independent history caches. Once initialized, a projection advances as
its indexed entries arrive. An invalid projection reports its evidence error to
its consumer; it does not turn unrelated entries into invalid evidence.

SessionManager adapters are shared by manager identity. File adapters are shared
by path through weak references, so an unused transcript can be collected. Neither
registry is a second durable store. Reload or reopening after collection can
reconstruct the same facts. Reconstruction does not start Runs, schedule Messages,
restore pending deliveries, or recreate incident handling.

`refresh()` obtains current committed evidence asynchronously. Concurrent refreshes
share consumption. Catch-up yields after at most 256 entries or one 64 KiB file
chunk. Coordination tool execution, lifecycle observations, incident reconciliation,
and explicit selector opening refresh before reading facts. Synchronous rendering
uses `snapshot()` while catch-up is running. `inspect()` is a synchronous current
read and drains the shared cursor, so latency-sensitive callers must refresh first
or use the rendering snapshot. A snapshot is a borrowed read-only view, not a frozen
copy of history. Its retained arrays advance with the transcript.

Branch and model-context construction is lazy. Coordination queries use all-branch
indexes. Selector model/thinking and recency use metadata retained during entry
consumption, without asking Pi to build model context or walk the active branch.

## Cursors and reconstruction

There are three different positions:

- The physical cursor tracks all appended entries. File readers separately retain
  the byte read position and an incomplete trailing buffer.
- The active leaf selects conversation context. Moving it does not remove
  coordination evidence on other branches.
- `inspectedThrough` names the last complete physical entry observed by a query.
  It is neither the active leaf nor a byte offset.

A JSONL record commits only at its terminating newline. The reader retains split
UTF-8 bytes until the complete line is available and rejects invalid UTF-8 or JSON.
It indexes one complete entry and advances its committed cursor in the same
synchronous operation. It never treats `message_end` as proof of an append. Reads
check the source even when no live notification arrived.

A SessionManager array replacement, session switch, or fork reconstructs the
adapter. Pi currently has no public physical append iterator: `getEntries()` filters
all history, while leaf traversal misses abandoned-branch appends. The adapter
therefore checks Pi's physical entry array in one isolated integration boundary.
Normal queries use the public session, header, and leaf accessors. A missing physical
array fails with `unsupported_pi_host`.

A file replacement, truncation, same-size rewrite, or changed committed cursor
anchor reconstructs retained state. The reader checks the last 128 committed bytes
when the file grows, rather than rescanning the prefix. Normal appended compaction
and branch-summary entries do not reconstruct the file. A new matching Identity
resets the current coordination cutoff and its projections while retaining physical
history. Historical entries before that cutoff remain available to conversation
context and carry no current coordination authority.

## Validation and measurements

Run the focused transcript contracts with:

```sh
node --test tests/agent-transcript.test.ts tests/transcript-facts.test.ts tests/request-evidence.test.ts
node --expose-gc benchmarks/transcript-consumption.ts
```

The benchmark reports Owner SessionManager and Agent file-backed paths at 2,000 and
20,000 historical entries, including authored Requests. It measures initial
reconstruction, 100 unchanged reads, one appended entry, a 10,000-entry backlog,
bytes read, entries parsed/consumed, retained heap, and event-loop delay. Fixture
construction and writes are outside consumption timing. Heap measurements require
`--expose-gc` and include retained indexes; the file-backed path also retains parsed
history, while SessionManager already owns its history.

On the implementation machine, unchanged reads performed no history work. A fixed
append consumed one entry at both history sizes. The 10,000-entry backlog took
13–26 ms and the queued event ran within 1.5 ms. These are observations, not portable
latency guarantees. Raw measurements and the copied workflow replay are retained
with the task's investigation artifacts.
