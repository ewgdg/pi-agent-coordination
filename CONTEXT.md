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
An explicit retry of an existing Message identity without changing that Message, optionally using a different delivery mode. Retrying an Agent Request may instead schedule its already-committed Agent Answer.
_Avoid_: Resend, new attempt

**Request**:
An Agent-authored question that creates exactly one Answer obligation. A Request has one stable identity and targets either another Agent or the human.

**Direct Spawner**:
The immutable Agent that created a child Agent. It may passively observe, interrupt, or terminate Runs of that immediate child across Run incarnations, but gains no authority over transitive descendants.

**Agent Spawn**:
One operation available to every normal authenticated Agent in a Workflow. It creates a fresh, context-isolated durable child Agent, makes the caller its immutable direct Spawner, and starts the child's first Run immediately without approval. The child exists permanently once its Agent Identity commits; that Identity references the Spawner's canonical Agent Spawn invocation as its creation source. Later startup or delivery failure never rolls the child back. Its initial work is the Creation Request; observation and Answer delivery use ordinary supervision and messaging semantics.

**Creation Request**:
The ordinary Agent Request committed after child creation by a direct Spawner as that child's initial work. Its correlated Agent Answer fulfills the Request's one Answer obligation without becoming an Agent lifecycle result.

**Agent Request**:
A Request targeting a known Agent in the same Workflow. Its Request identity is also the identity of its outbound Message.

**Agent Answer**:
An immutable responder-authored Message correlated to exactly one Agent Request. Its route follows from the Request, and its commit ends the responder's Answer obligation.

**Answer Retrieval**:
Requester-initiated scheduling of an already-committed Agent Answer by retrying its Request. It transports the responder's immutable Answer without impersonating the responder or authoring another Message.

**Request Cancellation**:
An immutable requester-authored Message withdrawing one exact Agent Request. It ends the requester's wait when committed and the responder's Answer obligation when delivered, without retracting facts or stopping work. An undelivered Request is suppressed without waking its responder; cancellation of a delivered Request may start a dormant responder through ordinary Message delivery. Cancellation remains one hop and never grants authority over the responder's Requests.

**Cooperative Cancellation**:
A responder's explicit decision, after receiving Request Cancellation, to cancel its own downstream Requests that are no longer needed. Every cancellation remains an independent requester-authored fact; there is no cascade identity or runtime claim that an entire dependency chain was cancelled.

**Run Retention Reason**:
A transient, live-observed reason the host must retain an exact Agent Run rather than dispose it. Active work, required input, pending delivery, unresolved Request relationships, interactive selection, and Owner host binding may each provide one.
_Avoid_: Completion blocker, Request blocker

**Interactive Selection**:
The transient presentation choice of which Agent receives native editor input. It retains that Agent's current Run without starting a dormant Agent.

**Run Release Gate**:
The live decision that permits automatic disposal of a child Agent Run only when no Run Retention Reason remains.

**Run Termination**:
An authorized controlled end of one exact current Agent Run that deliberately bypasses its Run Retention Reasons. It settles an exact pending Human Request through interruption but does not cancel Agent Requests, affect descendants, or create Agent lifecycle state. A later Message may start a successor Run for the same Agent.
_Avoid_: Agent termination

**Dependency Deadlock**:
A live closed component of current Agent Runs in which every Run is settled, retained solely by unresolved Request relationships within the component, and has no admitted input or other progress source. It is a transient observation that clears when its predicate changes, grants no additional authority, and is not reconstructed after host loss.

**Human Request**:
A blocking Request targeting the human and containing one or more Human Questions. An Agent may have at most one unresolved Human Request, while different Agents may have requests open concurrently.

**Human Question**:
One independently presented prompt within a Human Request. A request-specific UI presents multiple Human Questions as tabs.

**Human Answer**:
The structured set of human responses to a Human Request's Questions, canonically bound to that exact Request. It ends the Request's protocol obligation without claiming that its content is semantically sufficient.
_Avoid_: Human Response, Agent-confirmed resolution
