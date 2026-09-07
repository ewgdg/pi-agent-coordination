# Protocol identities

An Agent ID (`a1`, `a2`, ...) or Message ID (`m1`, `m2`, ...) is the canonical ID used directly in tool arguments, receipts, delivery, observation and presentation. A Request uses its Message ID, including a Spawn's Creation Request and a Human Request. There is no second long-ID/short-alias identity layer. IDs grow without a fixed length and are shown in full.

The Workflow ID is the Owner's globally unique Pi session ID. Each Agent Identity separately records `agentId`, `workflowId` and `sessionId`. The Owner, children and Moderators all allocate from the same Agent domain. A native Owner fork creates an independent Workflow and a fresh identity cutoff; copied coordination grants no authority there. Two Workflows can both have `a1` and `m1`.

Local references are interpreted only inside their enclosing Workflow. Tool-call evidence pointers carry `workflowId`, `agentId`, `entryId` and `toolCallId`; the Agent's bootstrap binds that source to its native Pi session. A reference used outside its enclosing Workflow must retain both Workflow and local ID. Authenticated child control routes to its own Owner coordinator; local IDs cannot select another Workflow.

## Durable allocation

The Owner coordinates child operations, but independent Owner processes can reopen the same Workflow. The allocator therefore uses SQLite transactions to update a per-Workflow, per-domain counter and its canonical-source assignment atomically, before returning the ID. Counters use decimal text and arbitrary-precision arithmetic. Interrupted uncommitted transactions roll back; committed allocations remain spent even when later Agent creation, delivery or confirmation fails.

The ledger is `pi-agent-coordination/identities.sqlite` under Pi's user directory (`PI_CODING_AGENT_DIR` when configured). Preserve this file with the Pi transcripts in backups and moves. It is durable identity state: it must not be deleted as a cache or reconstructed by renumbering transcript entries. Transcripts remain authoritative for Agent relationships, Message content and outcomes; allocation alone does not create those facts.

Source assignments survive restart, repeated projection, compaction, cancellation and removal of an Agent transcript. Agent and Message counters are independent, and a retry of the same source returns the committed ID rather than advancing its counter. Request scheduling and Answer obligation semantics are unchanged.
