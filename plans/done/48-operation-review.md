# Goal

Implement GitHub issue #48's concrete Operation Review capability: independently review overdue root Pi tool calls for answer-obligated Agents under exact attendance rules and allow policy-bounded Moderator renewal.

# Intention

Add one volatile operation-review watcher beside the existing Operational Incident coordinator. Observe only root Pi lifecycle and transcript-commit boundaries, keep one captured policy interval per admitted call, and feed expired calls into the existing Moderator creation, duplicate suppression, failure fallback, and Resolution path.

# Scope & Constraints

- Track every unresolved root Pi tool call independently by its exact committed `ToolCallPointer` and captured Workflow Policy snapshot.
- Classify a committed Pi tool batch as blocking when any issued tool declares sequential execution and as asynchronous only when the complete batch is parallel. Blocking intervals begin at execution admission; asynchronous intervals cover only continuous unattended Idle time.
- Review `ask_user_question` before Human Request commit and again during result-commit work, while excluding the human waiting interval.
- End an applicable interval on terminal tool-result commit, final Answer Obligation clearance, pre-expiry attendance resumption for asynchronous work, or valid Moderator renewal. Ignore progress, logs, heartbeat, partial output, and internal awaits.
- Expiry creates only an `operation_review` condition and minimal Moderator trigger. It does not abort, retry, interrupt, terminate, or claim an operation outcome.
- Let any Moderator renew an exact unresolved reviewable call in its Workflow with a positive interval no greater than the call's captured policy interval. Expected completion races return `stale`.
- Preserve Pi's user-configured compaction, retry, provider-retry, and transport behavior. Operation Review does not govern model-generation recovery.
- Preserve volatile handling and cold-host behavior. Do not persist timers, review state, attendance, or new lifecycle records.

# Confirmed Test Seams

1. A controllable-clock operation-review contract for independent blocking/asynchronous intervals, attendance, parallel calls, Human waiting, obligation clearance, commit races, and renewal.
2. Role-bound `WorkflowCoordinator` views backed by real Pi sessions for committed pointers, minimal Moderator Input, renewal receipts, Resolution, and no operational side effects.

Tests observe public receipts, transcript evidence, Moderator inputs, and Run behavior; they do not inspect watcher maps, timers, or private handling state.

# Work Plan

1. Add the controllable-clock tracer slice for one blocking call: admission, policy capture, obligation gating, expiry, terminal commit, and a minimal operation-review snapshot.
2. Add asynchronous attendance slices, independent parallel calls, pre-expiry resumption, and final-obligation clearance without treating progress updates as renewal.
3. Add Human Request phase transitions so request commit suspends review and submitted or interrupted result-commit work starts a fresh interval until terminal result evidence.
4. Extend Moderator trigger/input validation, metadata, presentation, Handling Keys, condition revalidation, failure fallback, and Resolution with `operation_review`.
5. Extend `moderator_control` with exact-pointer renewal, policy bounds, `renewed`/`stale` receipts, and serialized completion/expiry races without changing the watched tool or Run.
6. Update current design documentation for operation timing, renewal, and minimal trigger evidence.
7. Run focused tests, typechecking, review, and broad validation.

# Outcomes

Every answer-obligated root tool call receives independent, policy-captured review coverage without changing the operation itself. Human waiting is excluded, exact committed completion ends review, final obligation clearance permanently removes coverage, and Moderator renewal is exact-pointer, bounded, and race-safe. Expiry enters the existing transient Operational Incident path with minimal evidence.

Coordination leaves model-generation recovery to Pi's user-configured native behavior. It does not add a provider adapter, mutate recovery settings, or create another generation-recovery policy.
