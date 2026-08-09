# Live Agent Coordination

This context defines durable Agent identities and their transient live coordination within a Workflow.

## Language

**Agent Identity**:
The immutable transcript bootstrap facts for one Agent, bound to its expected Pi session identity. The ordinary Identity entry creates a Workflow Owner when its Agent ID equals its Workflow ID, or a spawned Agent when it names a Direct Spawner and matching Agent Spawn source. A runtime-created Moderator instead receives one atomic Moderator Input bootstrap containing its Workflow relationship, Agent Configuration, and model-visible creation reason.

**Owner Fork**:
A native Pi fork or clone of a Workflow Owner into a fresh independent Workflow. Its fresh Owner Identity is the protocol-evidence cutoff: copied earlier coordination remains model context but grants no Message, Request, authority, or child relationship in the new Workflow. Forking a child Agent or Moderator is not admitted.

**Protocol Identity**:
A stable identity derived from the canonical Pi invocation that first creates a coordination fact, using the fact kind to keep identities from different domains distinct. Agent Identity uses the Pi session identity directly, and Workflow identity is the Workflow Owner's Agent identity.

**Evidence Pointer**:
A durable reference to one Pi transcript entry or to one exact tool call within an assistant entry. An entry pointer contains its Agent and transcript-entry identities; a tool-call pointer additionally contains the native tool-call identity.

**Append Watermark**:
An Agent transcript entry pointer through which an all-branch inspection included every complete physical append. It identifies the observation boundary, not an active-branch position or a promise about later appends.

**Message**:
Immutable Agent-authored communication whose canonical payload, routing, and delivery mode come from its committed authoring tool call. Its stable identity, sender, and Workflow derive from that source; Message Retry never changes its delivery mode, and the tool result reports the identity and delivery outcome to the Agent without becoming a second Message record.

**Delivery Invocation**:
One volatile scheduling act created by a Message-authoring or Message Retry tool call. At most one pending scheduling item exists for a Message in its recipient host: a retry coalesces with that item or recreates it under the Message's fixed delivery mode. The invocation has no separate protocol identity, and delivery evidence does not retain which invocation achieved delivery.
_Avoid_: Delivery attempt

**Message Delivery**:
A process-committed, model-visible projection of a Message in its recipient Agent's transcript, structurally identified only by the Message's original tool-call source. It proves availability to session context, not model processing or effects.
_Avoid_: Acceptance, acknowledgment, processing confirmation

**Deferred Delivery**:
Delivery at a settled Idle boundary as its own model turn, preserving the recipient's current work.

**Steer Delivery**:
Batched delivery at the next safe model boundary after current generation and tools finish, without aborting either.
_Avoid_: Interruption

**Message Retry**:
An explicit idempotent request to ensure an existing Message is scheduled under its original delivery mode without changing that Message or duplicating a still-pending scheduling item. Retrying an Agent Request may instead schedule its already-committed Agent Answer.
_Avoid_: Resend, new attempt

**Request**:
An Agent-authored question that creates exactly one Answer obligation. A Request has one stable identity and targets either another Agent or the human.

**Direct Spawner**:
The immutable Agent that created a child Agent. It may passively observe, interrupt, or terminate Runs of that immediate child across Run incarnations, but gains no authority over transitive descendants.

**Agent Spawn**:
One operation available to each authenticated ordinary Agent—a Workflow Owner or spawned ordinary Agent—in a Workflow. It creates a fresh, context-isolated durable child Agent, makes the caller its immutable Direct Spawner, and starts the child's first Run immediately without approval. Its committed invocation also authors the child's Creation Request. The child Agent and Creation Request become canonical together when the child Agent Identity commits and references that invocation; later result, startup, or delivery failure never rolls either fact back. Ordinary Agents may use it for voluntary diagnostic delegation; Moderators do not create Agents.

**Creation Request**:
The ordinary Agent Request authored by an Agent Spawn invocation as its child's initial work. Its identity derives from that invocation as a Message, while the matching child Agent Identity supplies its recipient and makes it canonical. It then uses ordinary fixed-mode delivery, retry, cancellation, Answer, and Answer Retrieval semantics without becoming an Agent lifecycle result.

**Agent Template**:
A user-authored named partial Agent runtime configuration that may be selected during Agent Spawn. Apart from its name, it can prefill only the template-enabled parts of Agent Spawn configuration; working directory and Agent display metadata remain spawn-owned. Its current complete definition is re-resolved on every Run, overlays the Agent's immutable creation baseline, and remains overridable by that spawn without changing protocol identity or role relationships. Project-scoped discovery remains anchored to the Agent's Baseline Working Directory.
_Avoid_: Agent profile, Agent role

**Agent Configuration**:
The immutable Agent label, optional description, and creation baseline committed during Agent bootstrap. For a spawned Agent the baseline snapshots the spawning parent's inheritable runtime properties at creation, while every Run freshly applies the currently resolved selected Agent Template, canonical spawn overrides, and fixed role requirements.
_Avoid_: Agent settings, runtime state

**Baseline Working Directory**:
The immutable working directory inherited from the Direct Spawner's Effective Run Working Directory at Agent Spawn admission. A Moderator instead inherits the Workflow Owner's Effective Run Working Directory at Moderator creation. It anchors project-scoped Agent Template discovery and relative template or per-spawn working-directory values on every Run.

**Effective Run Working Directory**:
The working directory obtained for one Run by applying the immutable per-spawn override over the Baseline Working Directory. Pi discovers ordinary Project Context and cwd-scoped resources from this directory. It never redirects that Agent's template discovery.

**Workflow Policy**:
The Owner-scoped configuration snapshot governing new host admissions, limits, and operation review. Owner resource reload may replace it prospectively without making it transcript state or changing already-admitted work.
_Avoid_: Workflow state, Workflow configuration lifecycle

**Agent Request**:
A Request targeting a known Agent in the same Workflow. Its Request identity is also the identity of its outbound Message.

**Answer Obligation**:
The responder's live duty created by Agent Request Delivery and ended by committing the correlated Agent Answer or receiving Request Cancellation. Automatic moderation protects only work with at least one unresolved Answer Obligation.

**Agent Answer**:
An immutable responder-authored Message correlated to exactly one Agent Request. Its route follows from the Request, and its commit ends the responder's Answer obligation.

**Answer Retrieval**:
Requester-initiated delivery of an already-committed Agent Answer through the model-visible result of retrying its Request. The result is the Answer's recipient-side delivery proof and transports the responder's immutable Answer without impersonating the responder or authoring another Message.

**Request Cancellation**:
An immutable requester-authored Message withdrawing one exact Agent Request. It ends the requester's wait when committed and the responder's Answer obligation when delivered, without retracting facts or stopping work. An undelivered Request is suppressed without waking its responder; cancellation of a delivered Request may start a dormant responder through ordinary Message delivery. Cancellation remains one hop and never grants authority over the responder's Requests.

**Cooperative Cancellation**:
A responder's explicit decision, after receiving Request Cancellation, to cancel its own downstream Requests that are no longer needed. Every cancellation remains an independent requester-authored fact; there is no cascade identity or runtime claim that an entire dependency chain was cancelled.

**Run Retention Reason**:
A transient, live-observed reason the host must retain an exact Agent Run rather than dispose it. Active work, required input, pending delivery, unresolved Request relationships, interactive selection, interruption hold, unresolved Moderator handling, and Owner host binding may each provide one.
_Avoid_: Completion blocker, Request blocker

**Interactive Selection**:
The transient human choice to attach a full-window interactive view of one durable non-Owner Agent over the continuously bound Owner TUI. A live attachment gives its exact Run `interactive_selection` retention and presents that Run's complete child-owned Pi mode—transcript, Run state, widgets, editor, footer, commands, shortcuts, and extension UI—without transferring Owner runtime, services, diagnostics, transcript, editor, footer, or extension-context ownership. Input follows the child TUI's detached terminal path. Selecting a Dormant Agent is itself a Run-start trigger: it starts exactly one successor with `interactive_selection`, submits no model input, and exposes the initializing mode before startup UI settles. The selected successor accepts native commands, shell input, custom extensions, and later editor input through its normal live mode. Selection binds to that exact startup attempt and never retries a successor that ends during handoff. Closing while startup UI is pending cancels that exact initialization without requiring hidden UI input. Exact Run failure replaces the attachment with a view-owned Dormant failure presentation, and an ordinary Message-started successor attaches before Delivery execution. `/agents` switches the attachment or returns to Owner; Workflow disposal closes once, releases live retention, disposes only failure-presentation resources, and restores the untouched Owner presentation.

**Interruption Hold**:
The transient exact-Run pause established by confirmed authorized-supervisor interruption or Human Escape. It retains the Run, Requests, obligations, and pending scheduling while blocking ordinary Message Delivery commits and stuck-condition moderation. Only a native human editor Message commit or a standalone Supervisory Resume Message Delivery commit bound to that exact Hold atomically replaces it with an isolated resumption turn; explicit Run Termination instead ends the held Run and discards its undelivered backlog.

**Supervisory Resume Message**:
An authorized supervisor's free-form Message requesting that one exact held Agent Run continue. It uses reserved fixed resumption scheduling, clears only the exact Interruption Hold against which it was admitted when its standalone Delivery commits, and otherwise remains ordinary Steer direction without gaining power over a later Hold.

**Run Release Gate**:
The live decision that permits automatic disposal of a child Agent Run only when no Run Retention Reason remains.

**Run Termination**:
An authorized controlled end of one exact current Agent Run that deliberately bypasses its Run Retention Reasons. Ordinary termination is rejected while the Agent owns Interactive Selection; completed deselection permits termination. It settles an exact pending Human Request through interruption but does not cancel Agent Requests, affect descendants, or create Agent lifecycle state. A later Message may start a successor Run for the same Agent.
_Avoid_: Agent termination

**Run Failure**:
The unexpected terminal end of one exact Agent Run after any applicable Automatic Reconciliation could not preserve that Run. It starts Moderator handling only while the failed Agent retains an unresolved Answer Obligation and clears when a successor Run starts or every such obligation ends through Agent Answer commit or Request Cancellation Delivery. It does not mark the durable Agent or Workflow failed, reconstruct work, or start a successor Run automatically. An open Interactive Selection remains on the durable Agent through a passive Dormant failure presentation until explicit human input or ordinary coordination starts a successor.

**Dependency Deadlock**:
A live closed component of current Agent Runs in which every Run is settled, retained solely by unresolved Request relationships within the component, and has no admitted input or other progress source. It is a transient observation that clears when its predicate changes, grants no additional authority, and is not reconstructed after host loss.

**Obligation Stall**:
A settled Agent Run retained by an Answer Obligation it must discharge, with no active or admitted work, external progress source, or Interruption Hold. An unresolved outgoing Request to a dormant Agent is not an external progress source. It starts Moderator handling immediately.

**Operational Incident**:
A predefined suspicious live coordination condition blocking at least one unresolved Answer Obligation and starting Moderator handling. It is a transient occurrence rather than a durable aggregate or lifecycle; unnecessary review is preferable to silently stranded obligated work.

**Handling Key**:
A derived host-local key that suppresses repeated Moderator creation while one continuous Operational Incident is being handled or shown as exhausted Owner attention. It is transient correlation rather than Incident identity, is released when the condition clears, and is not persisted or reconstructed after host loss.

**Operation Review Deadline**:
The runtime-owned limit on how long one root Pi tool call belonging to an Agent with an unresolved Answer Obligation may remain unresolved before operational review is required. The watcher does not inspect the tool's internal awaits or separately review background coordination work after its root call returns. A blocking call is reviewed from execution admission; an asynchronous call is reviewed only across a continuous unattended wait, beginning when its Run reaches an Idle boundary and ending if Agent work resumes before expiry. Terminal tool-result commit or explicit Moderator renewal ends the current interval, while tool progress, heartbeat, logs, or other machinery activity does not. It does not govern model generation, and expiry establishes no operational outcome.

**Automatic Reconciliation**:
A bounded runtime response to an exactly recognized model-generation fault, available only where the provider or Agent Session adapter guarantees safe continuation in the same exact Agent Run without repeating a committed tool effect. It never reconciles a tool call, reconstructs work in a successor Run, or retries an ambiguous generation outcome. Unavailable, exhausted, or indeterminate reconciliation ends the exact Run; ordinary Run Failure moderation then applies only while an Answer Obligation remains.

**Moderator**:
A fresh runtime-created normal Agent with no direct Spawner, running the predefined diagnostic role and role-scoped toolset for one Operational Incident and never reused. Moderator Input foregrounds the affected Agents, while trusted workflow-wide pull visibility permits broader diagnosis without eagerly loading unrelated context. Its separate Pi session keeps automatic operational investigation out of ordinary Agent working context.

**Moderator Input**:
The atomic model-visible identity bootstrap that creates and initializes one Moderator with its Workflow relationship, Agent Configuration, trigger snapshot, bounded qualifying Request sources, affected-Agent inspection watermarks, and any previous Moderator-attempt watermark. Native entry metadata supplies its time, and the entry itself truthfully establishes runtime creation with no Direct Spawner. It is the sole durable projection of why that Moderator exists, not an Incident identity, mutable status, scope, or authority grant.

**Moderator Behavioral Boundary**:
The trusted rule that a Moderator uses its role-scoped messaging, inspection, and non-Owner supervisory controls only to restore safe progress, records its rationale, and asks the Workflow Owner for task intent, policy, value, or risk judgment. Structural invariants still prohibit Agent creation, impersonation, acting on another Agent's Requests, transcript or identity mutation, control of the Owner Run, and machinery retries without adapter-declared safe reconciliation.

**Moderator Resolution**:
The explicit Moderator tool outcome that records its summary and rationale, requires the Moderator's own incoming and outgoing Request relationships to be settled, verifies any mechanically checkable trigger has cleared, releases transient duplicate suppression, and permits the Moderator Run to close. If the qualifying Answer Obligations cleared externally, it reports `already_cleared`; the tool call and result are ordinary transcript evidence, not an Incident lifecycle or record.

**Moderator Escalation**:
An ordinary free-form Agent Request from a Moderator to the Workflow Owner for task intent, policy, value, risk, Owner action, or another choice the Moderator cannot verify as mechanically safe. Its ordinary Agent Answer guides further handling; it creates no special packet, handoff, or transfer of control, and the Moderator still records Moderator Resolution afterward.

**Moderator Failure Fallback**:
The bounded response when a Moderator Run terminally fails after same-Run Automatic Reconciliation: one fresh replacement Moderator continues the original handling with pointers to the first attempt. Failure of that replacement stops automatic attempts and creates a passive Workflow Owner Attention Inbox entry centered on the original condition and affected Agents rather than on Moderator recovery.

**Human Request**:
A blocking Request targeting the human and containing one or more Human Questions. Its committed `ask_user_question` tool call is the canonical Request; a spawned ordinary Agent or Moderator may have at most one unresolved Human Request, while different Agents may have requests open concurrently. The Workflow Owner does not author Human Requests.

**Human Question**:
One independently presented prompt within a Human Request. A request-specific UI presents multiple Human Questions as tabs, and its matching Human Answer is identified by the Question's stable position in that Request.

**Human Answer**:
The successful native tool result containing the structured set of human responses to a Human Request's Questions, canonically bound to that exact tool call. It ends the Request's protocol obligation without claiming that its content is semantically sufficient.
_Avoid_: Human Response, Agent-confirmed resolution
