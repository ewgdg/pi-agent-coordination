# Live Agent Coordination

This context defines durable Agent identities and their transient live coordination within a Workflow.

## Language

**Message**:
Immutable Agent-authored communication with one stable identity, sender, recipient, Workflow, and canonical payload.

**Delivery Invocation**:
One volatile scheduling act created by an Outbound Message or Message Retry transcript entry. Its source transcript entry identifies it; it has no separate protocol identity.
_Avoid_: Delivery attempt

**Message Delivery**:
A process-committed, model-visible projection of a Message in its recipient Agent's transcript. It proves availability to session context, not model processing or effects.
_Avoid_: Acceptance, acknowledgment, processing confirmation

**Deferred Delivery**:
Delivery at a settled Idle boundary as its own model turn, preserving the recipient's current work.

**Steer Delivery**:
Batched delivery at the next safe model boundary after current generation and tools finish, without aborting either.
_Avoid_: Interruption

**Message Retry**:
An explicit new Delivery Invocation for an existing Message identity. It preserves the Message while allowing a different delivery mode.
_Avoid_: Resend, new attempt

**Request**:
An Agent-authored question that creates exactly one Answer obligation. A Request has one stable identity and targets either another Agent or the human.

**Agent Request**:
A Request targeting a known Agent in the same Workflow. Its Request identity is also the identity of its outbound Message.

**Human Request**:
A blocking Request targeting the human and containing one or more Human Questions. An Agent may have at most one unresolved Human Request, while different Agents may have requests open concurrently.

**Human Question**:
One independently presented prompt within a Human Request. A request-specific UI presents multiple Human Questions as tabs.

**Human Answer**:
The structured set of human responses to a Human Request's Questions, canonically bound to that exact Request. It ends the Request's protocol obligation without claiming that its content is semantically sufficient.
_Avoid_: Human Response, Agent-confirmed resolution
