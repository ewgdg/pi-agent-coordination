# Replace direct-child observation with composable Agent search

`agent_observe` now keeps exact status lookup and uses one bounded composable search operation for authorized Agent discovery, replacing its public direct-child operation. Structural scope, metadata, compact-ID suffix, lifecycle phase, and result limits belong together because large nested and dormant rosters make repeated child enumeration noisy, while current Run state cannot be recovered reliably by raw transcript `rg`; transcript content remains an explicit evidence-inspection concern.

## Consequences

- The model-facing protocol has one multi-Agent observation result shape: bounded `matches` plus `hasMore`.
- Internal Agent graph and UI child APIs remain direct-child projections; only the public observation operation changed.
- Search is live and non-atomic, and never prepares a dormant Runtime.
