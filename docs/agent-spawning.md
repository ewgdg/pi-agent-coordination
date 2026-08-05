# Agent spawning

Every ordinary Agent can create one fresh child per `agent_spawn` call:

```ts
agent_spawn({
  request: "Inspect the failing integration and report the smallest safe fix.",
  description: "Investigates one integration failure",
})
```

`request` is required. `description` is optional display metadata. The child label is `agent`. The authenticated calling Agent becomes the immutable Direct Spawner; identities, Workflow membership, runtime configuration, and delivery mode are not caller-supplied fields.

The child receives a fresh durable Pi session and inherits the caller's effective working directory, model, thinking level, ordinary tools, skills, and extensions at creation. It does not inherit the caller's transcript, branch, model context, editor state, or queued input.

## Commitment and delivery

The committed native `agent_spawn` tool call is the Creation Request source. The child Identity append commits the child and Request together. After that append, startup or scheduling failure never removes either fact.

The child starts an in-process Run and receives the Request through fixed Deferred Delivery. A successful spawn receipt reports volatile admission; it does not claim that Delivery committed, the model processed the Request, or an Answer exists.

## Receipts

- `pending` — the child and Request exist, the first Run started, and Delivery was admitted.
- `created_unscheduled` — the child and Request exist, but confirmed Run startup or Delivery admission failed.
- `not_created` — validation failed before child Identity committed.
- `indeterminate` — confirmation was lost at a boundary where effects may exist.

Repeating `agent_spawn` creates a sibling. Direct children appear to their Spawner in canonical spawn-call order. Observation is passive and returns bounded identity and live Run state without exposing a Pi session or Run handle.
