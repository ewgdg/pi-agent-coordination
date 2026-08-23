# Live Agent Coordination

This context defines durable Agent identities and their transient live coordination within a Workflow.

## Language

**Agent Identity**:
The immutable transcript bootstrap facts for one Agent, bound to its expected Pi session identity. The ordinary Identity entry creates a Workflow Owner when its Agent ID equals its Workflow ID, or a spawned Agent when it names a Direct Spawner, matching Agent Spawn source, and display metadata. A runtime-created Moderator instead receives one atomic Moderator Input bootstrap containing its Workflow relationship, display metadata, and model-visible creation reason. Resolved Runtime configuration is not Agent Identity.

**Owner Identity Canonicalization**:
The canonical interpretation of ordinary Identity evidence using the live Pi session for both Owner identity IDs and current Owner metadata. Malformed or copied ordinary Identity evidence is historical during recovery, and one current-scope Owner bootstrap may be appended when needed; a structurally valid child Identity for the current session remains a child. A distinct Moderator Input remains a separate role bootstrap.

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
One operation available to each authenticated ordinary Agent—a Workflow Owner or spawned ordinary Agent—in a Workflow. It creates one fresh durable child Agent, makes the caller its immutable Direct Spawner, and starts the child's first Run immediately without approval. The child is context-isolated unless the caller selects a Conversation Fork. The committed invocation also authors the child's Creation Request. The child Agent and Creation Request become canonical together when the child Agent Identity commits and references that invocation; later result, startup, or delivery failure never rolls either fact back. Ordinary Agents may use it for voluntary diagnostic delegation; Moderators do not create Agents.

**Conversation Fork**:
An Agent Spawn mode that copies the Direct Spawner's active conversation only through the completed context immediately before the assistant entry containing the canonical Spawn call. It creates a new child in the same Workflow rather than a new Workflow. The fresh matching child Identity is the protocol-evidence cutoff: copied earlier coordination remains model context but grants no authority, Message visibility, child relationship, or Answer obligation. One model-visible handoff after that cutoff identifies inherited authorship before the ordinary Creation Request. A Conversation Fork cannot select an Agent Template or provide Agent Spawn Configuration, and its first provider request preserves the parent's prompt lineage for cache affinity without claiming a cache hit.

**Creation Request**:
The ordinary Agent Request authored by an Agent Spawn invocation as its child's initial work. Its identity derives from that invocation as a Message, while the matching child Agent Identity supplies its recipient and makes it canonical. It then uses ordinary fixed-mode delivery, retry, cancellation, Answer, and Answer Retrieval semantics without becoming an Agent lifecycle result.

**Agent Delegation**:
Assignment of one bounded work unit to another Agent through an Agent Request or an Agent Spawn Creation Request. A Request for existing information or a decision need not delegate work. Once admitted, the responder owns delegated work until its Agent Answer commits or the Request is cancelled; the requester and concurrent delegates keep their work disjoint unless the Request explicitly asks for an independent cross-check.

**Continuation Delegation**:
A delegating Agent's assignment of a new bounded work unit to an existing Agent because context that Agent acquired through earlier work materially reduces rediscovery. The delegating Agent decides relevance and uses an ordinary Agent Request; reuse adds no eligibility rule, routing behavior, authority, or lifecycle state.

**Continuation Work Scale**:
The delegating Agent's ordinal estimate of expected growth: Small for one localized follow-up, Medium for a normal bounded sequence of investigation, edits, tests, or review, and Large for extended multi-stage work that remains one delegation. It describes growth rather than difficulty, importance, risk, or a token count.

**Prior-Context Dependence**:
The delegating Agent's ordinal estimate of the value of exact earlier context: Low when a good summary is sufficient, Medium when decisions and work history matter but can mostly be summarized, and High when exact recent reasoning, outputs, or nuanced constraints remain materially valuable. Even Low materially reduces rediscovery, while High delays only proactive compaction and never Pi's native safety behavior.

**Working-Zone Preparation**:
A delegating Agent's optional non-model-visible Request intent for an idle Continuation Delegation recipient to use Continuation Work Scale and Prior-Context Dependence when deciding whether the Active Compaction Strategy would control repeated context cost without discarding valuable prior work. It respects user-disabled automatic compaction, never changes Delivery mode or authority, makes at most one stateless attempt per admission, and lets optional failure below Pi's native safety threshold continue normally.

**Active Compaction Strategy**:
The compaction behavior selected through an Agent Runtime's public session lifecycle, including Pi summarization or an extension-owned provider checkpoint. It owns the retained-context target, instruction support, persistence, diagnostics, and fallback behavior while accepting prospective relevance guidance when supported.

**Agent Template**:
A user-authored named partial Agent Runtime configuration selected by name during Agent Spawn. Its current complete definition is re-resolved whenever a new Runtime is prepared. It overlays the current resolved configuration of the Direct Spawner, remains overridable by the canonical Agent Spawn configuration, and changes neither protocol identity nor role relationships. Project-scoped Template discovery follows the current parent Runtime working directory. A retained Runtime keeps its already resolved configuration across its exact Runs.
_Avoid_: Agent profile, Agent role

**Agent Template Catalogue Snapshot**:
The immutable model-safe selection summary captured when the Workflow Owner is admitted or reloaded, or when another spawning Agent Runtime is prepared. It contains the currently selectable Agent Templates without source paths or Project Context bodies, and is exposed only through the active Agent Spawn tool guidance. Every Run in that retained Runtime reuses the Snapshot without resource discovery; Owner resource reload and fresh Runtime Preparation capture replacements. The Snapshot guides selection but grants no authority and is never execution configuration: Agent Spawn re-resolves the selected Template from current resources before preparing a child Runtime.
_Avoid_: Template cache, Template configuration

**Agent Spawn Configuration**:
The optional caller-authored `config` object in a context-isolated canonical Agent Spawn tool call. It is the only durable child Runtime configuration input and may override model, thinking, working directory, the ordinary-tool allowlist, skills, extension inheritance, and Project Context. The allowlist is a capability ceiling; Pi and extensions own the active subset and its order. It is never expanded into durable effective configuration. A Conversation Fork rejects Agent Spawn Configuration.
_Avoid_: Agent settings, runtime state, inheritance snapshot

**Shared Pi User Configuration**:
The user-owned Pi preference space shared by the Owner and every child Agent Runtime. Runtime Preparation may select effective values without changing it, while an explicit user preference action from any interactive Agent view updates the same shared preferences.
_Avoid_: Owner configuration, child configuration

**Runtime Preparation**:
The volatile resolution performed immediately before one new Agent Runtime starts. For an ordinary Agent it recursively obtains the current parent Runtime configuration, resolves the Agent's current selected Template and canonical Agent Spawn Configuration, adds fixed role requirements, and discovers current resources, trust, and Project Context. A Moderator instead resolves the current Owner Runtime and current reserved `moderator` Template. Without a Template model selection, Moderator preparation inherits the Owner model but delegates thinking selection to Pi's shared user default. The launch specification may be serialized for that process launch but is never transcript evidence or recovery configuration.

**Effective Run Working Directory**:
The working directory obtained during Runtime Preparation by resolving the canonical per-spawn `cwd` against the current parent Runtime working directory. It anchors that Agent's project-scoped Template discovery for descendants and Pi's ordinary Project Context and cwd-scoped resource discovery for the prepared Runtime.

**Workflow Policy**:
The Owner-scoped configuration snapshot governing new host admissions, limits, and operation review. Its execution limit counts concurrent child Agent Runs only; the canonical Workflow Owner and Moderators enter immediately without consuming child capacity. Owner resource reload may replace the Policy prospectively without making it transcript state or changing already-admitted work.
_Avoid_: Workflow state, Workflow configuration lifecycle

**Agent Request**:
A Request targeting a known Agent in the same Workflow. Requests waiting for one responder become eligible for Delivery in admission order, and only the front Request may deliver while that responder has no unresolved Answer Obligation. Each Request keeps its authored Delivery mode. Its Request Message identity, named `requestMessageId`, is the public identity for Cancellation, retry, and retrieval.

**Agent Observation Search**:
A passive lookup over the caller's authorized verified Agent identities. It combines structural scope, stable Agent metadata, and an Agent's current Run phase to return a bounded set of Agent Statuses. It is a live, potentially non-atomic observation and never prepares a Runtime or searches transcript contents.
_Avoid_: transcript search, evidence search

**Answer Obligation**:
The responder's sole live duty created by Agent Request Delivery and ended by committing the correlated Agent Answer or receiving Request Cancellation. While the obligation is active, an ordinary Message to that Request's requester is rejected without creating a Message; the responder instead keeps provisional findings local, commits the curated Agent Answer, or authors a reverse Agent Request when requester input is needed. Automatic moderation protects only work with an unresolved Answer Obligation.

**Agent Answer**:
An immutable responder-authored Message correlated by the coordinator to the responder's sole Answer Obligation. Its route follows from that Request, and its commit ends the obligation.

**Answer Retrieval**:
Requester-initiated delivery of an already-committed Agent Answer through the model-visible result of retrying its Request or joining outstanding Request Answers. The result is the Answer's recipient-side delivery proof and transports the responder's immutable Answer without impersonating the responder or authoring another Message. Retrieval may win while direct Answer Delivery remains only scheduler-held; once direct Answer Delivery owns a frozen or dispatched scheduling reservation, retrieval waits for its proof rather than competing with it. Native tool-result commitment re-arbitrates a previously prepared retrieval against current direct Delivery reservation and proof.

**Agent Wait**:
One explicit parameterless join over the caller's outstanding Agent Requests. When its committed sequential tool call begins execution, it fixes a non-empty snapshot in canonical Request authoring order, including unanswered Requests and committed Answers without requester-side Delivery proof while excluding cancellations, prior Answer Deliveries, and later Request sources. It rejects without parking when any unanswered snapshot Request targets an Agent observed as Dormant; an already committed Answer remains retrievable regardless of its responder's Run phase. Otherwise it parks the exact Run until every Request in that snapshot has a canonical Agent Answer or an eligible inbound Agent Request needs that Run's attention; a child caller releases its child execution slot while parked, while Owner and Moderator Runs never consume child capacity. At that boundary a fully committed aggregate wins; otherwise the inbound Request is delivered and the Wait completes as Preempted without consuming Answers. A committed aggregate becomes requester-side Delivery proof for Answers not already delivered, while Preemption creates no Answer Delivery proof and a later Wait takes a fresh outstanding snapshot. Ordinary Messages neither satisfy Agent Requests nor preempt Agent Wait. Live notification, the pending Promise, and five-second transcript reconciliation are volatile machinery. A successor Run may issue a new Agent Wait to retrieve its still-outstanding committed Answers, but unfinished Wait calls are not reconstructed and waiting never retries Request Delivery.
_Avoid_: Answer cache, Request retry, durable Wait

**Agent Wait Preemption**:
The non-error completion of one Agent Wait when an eligible inbound Agent Request requires the parked exact Run. It reserves and commits that Request Delivery before the Agent's next model generation, reacquires child execution capacity when the caller is a child, and leaves every Answer available for ordinary Delivery or a fresh later Wait. Any inbound Agent Request may qualify independently of the outstanding snapshot's responders; ordinary Deferred Messages remain queued.
_Avoid_: interruption, failure, Answer retrieval

**Request Cancellation**:
An immutable requester-authored Message withdrawing one exact Agent Request, named at the authoring boundary by that Request's Message identity. It ends the requester's wait when committed and the responder's Answer obligation when delivered, without retracting facts or stopping work. An undelivered Request is suppressed without waking its responder; cancellation of a delivered Request may start a dormant responder through ordinary Message delivery. Cancellation remains one hop and never grants authority over the responder's Requests.

**Cooperative Cancellation**:
A responder's explicit decision, after receiving Request Cancellation, to cancel its own downstream Requests that are no longer needed. Every cancellation remains an independent requester-authored fact; there is no cascade identity or runtime claim that an entire dependency chain was cancelled.

**Agent Runtime**:
The volatile Pi session, configured resources, and interactive presentation currently hosted for one durable Agent Identity. A Runtime can be prepared while its Agent is Dormant and can remain available across successive Runs while interactively selected. Preparing it executes ordinary extension lifecycle behavior without censoring extension effects; any effect that initiates Agent work admits a Run normally.

**Turn Compaction Gateway**:
The child-local, Runtime-generation-bound admission boundary that serializes only turn preparation and commitment. It cancels unused post-Run threshold compaction, recomputes threshold preparation before later idle work, preserves Pi-native manual and overflow compaction, and releases before the model cycle. Deferral is not durable state and does not retain a Run or Agent Runtime.

**Run**:
One exact transient epoch of admitted Agent work within an Agent Runtime. Initial creation work, model-starting human or extension input, and coordination Delivery can start a Run; navigation and UI-only commands cannot. Exact Run identity fences interruption, termination, failure, Human Requests, Delivery scheduling, and Operational Incident evaluation. Releasing, failing, or terminating a Run does not remove its durable Agent Identity and need not replace a selected Agent Runtime.

**Run Retention Reason**:
A transient, live-observed reason the host must retain an exact Agent Run. Active work, required input, pending delivery, unresolved Request relationships, interruption hold, unresolved Moderator handling, and Owner host binding may each provide one.
_Avoid_: Completion blocker, Request blocker

**Agent Runtime Retention Reason**:
A transient reason to keep an Agent Runtime available independently of Run admission. Interactive Selection provides the current Runtime retention reason.

**Interactive Selection**:
The transient human choice to attach the physical terminal to one durable non-Owner Agent's process-isolated PTY while the continuously bound Owner TUI is suspended in place. Selection prepares and retains that Agent's configured Runtime and shows its native transcript, Run state, widgets, editor, footer, commands, shortcuts, and extension UI without transferring Workflow ownership. Selection itself does not admit a Run, initialize Run-scoped Request relationships, invoke the model, or append transcript evidence. User input, slash-command effects, extension lifecycle effects, and coordination Delivery keep their ordinary power: if they initiate Agent work, the same Runtime enters a Run. Run failure leaves the selected Runtime and view in place while the Agent becomes Dormant. Closing a never-activated view disposes only its prepared Runtime and cannot create an Operational Incident. If Dormant Runtime Preparation fails before publishing a usable projection, the host instead presents one read-only Post-mortem View of durable transcript evidence without fabricating a Runtime or changing Agent state.

**Post-mortem View**:
An Owner-hosted read-only presentation of one coherent active-branch snapshot from a durable Agent transcript, used only when Dormant Runtime Preparation cannot produce a usable projection. It shows the Runtime preparation error separately, admits no Run, creates no Runtime or retention, appends no evidence, and does not mark the durable Agent failed. Closing it restores the exact previously mounted Owner or Agent presentation.

**Selected Agent Status**:
The human-facing lifecycle and work disposition of an Agent under Interactive Selection. It is Dormant when no exact Run exists. A healthy current Run is Active while work is executing, Waiting with a concise reason when progress requires a named external condition or human action, and Idle when settled without such a wait. Starting, Ending, and Failed communicate lifecycle transitions or failure separately.

**Interruption Hold**:
The transient exact-Run pause established by confirmed authorized-supervisor interruption or Human Escape. It retains the Run, Requests, obligations, and pending scheduling while blocking ordinary Message Delivery commits and stuck-condition moderation. Only a native human editor Message commit or a standalone Supervisory Resume Message Delivery commit bound to that exact Hold atomically replaces it with an isolated resumption turn; explicit Run Termination instead ends the held Run and discards its undelivered backlog.

**Supervisory Resume Message**:
An authorized supervisor's free-form Message requesting that one exact held Agent Run continue. It uses reserved fixed resumption scheduling, clears only the exact Interruption Hold against which it was admitted when its standalone Delivery commits, and otherwise remains ordinary Steer direction without gaining power over a later Hold.

**Run Release Gate**:
The live decision that permits an exact child Agent Run to end only when no Run Retention Reason remains. A separately retained Agent Runtime may remain prepared after Run release.

**Run Termination**:
An authorized controlled end of one exact current Agent Run that deliberately bypasses its Run Retention Reasons. It may end the exact Run of a selected Agent while retaining that Agent's ready Runtime and open view, leaving the Agent Dormant. If termination wins while that Runtime is still initializing, it fences the exact projection, cancels initialization, blocks queued successor admission through lane finalization, and closes the not-yet-usable view instead of waiting for startup UI. Every native editor submission observed before the termination fence is discarded even if its asynchronous preflight reaches Run admission after projection disposal; only a later submission from the current exact projection may start a successor. Termination settles an exact pending Human Request through interruption but does not cancel Agent Requests, affect descendants, or create Agent lifecycle state. A later Message or native input may start a successor Run in the same retained Runtime.
_Avoid_: Agent termination

**Run Failure**:
The unexpected terminal end of one exact Agent Run after Pi's user-configured native recovery behavior has finished. It starts Moderator handling only while the failed Agent retains an unresolved Answer Obligation and clears when a successor Run starts or every such obligation ends through Agent Answer commit or Request Cancellation Delivery. It does not mark the durable Agent or Workflow failed, reconstruct work, or start a successor Run automatically. An open Interactive Selection keeps the same Agent Runtime and presentation while the Agent becomes Dormant; later input or coordination may admit a successor in that Runtime.

**Dependency Deadlock**:
A live closed component of current Agent Runs in which every Run is settled, retained solely by unresolved Request relationships within the component, and has no admitted input or other progress source. It is a transient observation that clears when its predicate changes, grants no additional authority, and is not reconstructed after host loss.

**Obligation Reminder**:
One runtime-authored, model-visible Deferred Delivery sent when a simple Obligation Stall first appears for an exact Request identity. It carries only that identity, a bounded normalized Request snippet, and direct Answer guidance. Durable transcript proof suppresses another reminder for the same obligation across later Runs and recurring Stall conditions. If the reminded Agent settles again without discharging the obligation, Moderator handling begins. Dependency Deadlock members use their normalized Deadlock handling instead of individual reminders.

**Obligation Stall**:
A settled Agent Run retained by an Answer Obligation it must discharge, with no active or admitted work, external progress source, or Interruption Hold. An unresolved outgoing Request to a dormant Agent is not an external progress source. The first simple occurrence schedules an Obligation Reminder; a later occurrence with durable reminder proof starts Moderator handling.

**Operational Incident**:
A predefined suspicious live coordination condition blocking at least one unresolved Answer Obligation and starting Moderator handling. It is a transient occurrence rather than a durable aggregate or lifecycle; unnecessary review is preferable to silently stranded obligated work.

**Handling Key**:
A derived host-local key that suppresses repeated Moderator creation while one continuous Operational Incident is being handled or shown as exhausted Owner attention. It is transient correlation rather than Incident identity, is released when the condition clears, and is not persisted or reconstructed after host loss.

**Operation Review Deadline**:
The runtime-owned limit on how long one root Pi tool call belonging to an Agent with an unresolved Answer Obligation may remain unresolved before operational review is required. The watcher does not inspect the tool's internal awaits or separately review background coordination work after its root call returns. A blocking call is reviewed from execution admission; an asynchronous call is reviewed only across a continuous unattended wait, beginning when its Run reaches an Idle boundary and ending if Agent work resumes before expiry. Terminal tool-result commit or explicit Moderator renewal ends the current interval, while tool progress, heartbeat, logs, or other machinery activity does not. It does not govern model generation, and expiry establishes no operational outcome.

**Moderator**:
A fresh runtime-created normal Agent with no direct Spawner, running the predefined diagnostic role and role-scoped toolset for one Operational Incident and never reused. Moderator Input foregrounds the affected Agents, while trusted workflow-wide pull visibility permits broader diagnosis without eagerly loading unrelated context. Its separate Pi session keeps automatic operational investigation out of ordinary Agent working context.

**Moderator Input**:
The atomic model-visible identity bootstrap that creates and initializes one Moderator with its Workflow relationship, fixed display metadata, trigger snapshot, bounded qualifying Request sources, affected-Agent inspection watermarks, and any previous Moderator-attempt watermark. Native entry metadata supplies its time, and the entry itself truthfully establishes runtime creation with no Direct Spawner. It is the sole durable projection of why that Moderator exists, not an Incident identity, mutable status, scope, or authority grant.

**Moderator Behavioral Boundary**:
The trusted rule that a Moderator uses its role-scoped messaging, inspection, and non-Owner supervisory controls only to restore safe progress, records its rationale, and asks the Workflow Owner for task intent, policy, value, or risk judgment. Structural invariants still prohibit Agent creation, impersonation, acting on another Agent's Requests, transcript or identity mutation, control of the Owner Run, and machinery retries without adapter-declared safe reconciliation.

**Moderator Resolution**:
The explicit Moderator tool outcome that records its summary and rationale, requires the Moderator's own incoming and outgoing Request relationships to be settled, verifies any mechanically checkable trigger has cleared, releases transient duplicate suppression, and permits the Moderator Run to close. If the qualifying Answer Obligations cleared externally, it reports `already_cleared`; the tool call and result are ordinary transcript evidence, not an Incident lifecycle or record.

**Moderator Escalation**:
An ordinary free-form Agent Request from a Moderator to the Workflow Owner for task intent, policy, value, risk, Owner action, or another choice the Moderator cannot verify as mechanically safe. Its ordinary Agent Answer guides further handling; it creates no special packet, handoff, or transfer of control, and the Moderator still records Moderator Resolution afterward.

**Moderator Failure Fallback**:
The bounded response when a Moderator Run terminally fails after Pi's user-configured native recovery behavior has finished: one fresh replacement Moderator continues the original handling with pointers to the first attempt. Failure of that replacement stops automatic attempts and creates a passive Workflow Owner Attention Inbox entry centered on the original condition and affected Agents rather than on Moderator recovery.

**Human Request**:
A blocking Request from an ordinary Agent or Moderator asking the human one free-form question. Each Agent may have at most one unresolved Human Request, while different Agents may have requests open concurrently; the Workflow Owner does not author Human Requests.

**Human Answer**:
The human-authored free-form text that resolves one Human Request and allows its requesting Run to continue. It does not claim that its content is semantically sufficient.
_Avoid_: Human Response, Agent-confirmed resolution
