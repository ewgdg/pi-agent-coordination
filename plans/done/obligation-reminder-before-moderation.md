# Obligation reminder before moderation

## Goal

When an ordinary Agent settles while still owing an Answer and no other progress source exists, deliver one runtime-authored reminder for that exact Request before creating an Obligation Stall Moderator. If the Agent settles again with the same obligation unresolved, moderation proceeds normally.

## Intention

Recover the common “forgot to answer” case with one cheap model turn while preserving Moderator handling for persistent stalls.

## Scope & Constraints

- Reminder eligibility is exactly the existing Obligation Stall predicate.
- Suppression is per durable Request identity, not per Run. A successor Run does not earn another reminder for the same obligation.
- Reminder content contains the Request identity, a bounded normalized snippet, and direct Answer guidance; it never repeats the full Request body.
- Reminder Delivery is model-visible, runtime-authored, transcript-verifiable, and uses existing deferred custom Delivery scheduling.
- Operation Review and Run Failure behavior remain unchanged. A normalized Dependency Deadlock takes precedence over member-level Stall reminders and moderation.
- Unknown coordination-entry validation must continue rejecting genuinely unknown entries.

## Work Plan

1. Add a protocol module for the reminder shape, bounded snippet, Delivery identity, construction, parsing, and transcript inspection.
2. Admit the reminder from Operational Incident reconciliation before creating an Obligation Stall handling record. On later recurrence, durable reminder evidence permits Moderator creation.
3. Extend Runtime Delivery and process-control schemas for the new custom message type.
4. Exclude the known host-authored reminder from ordinary Agent Message Delivery evidence parsing.
5. Add protocol and integration coverage, then adapt existing Obligation Stall fixtures to the new two-stage behavior.
6. Update operational-incident documentation.

## Validation

- Targeted protocol/unit tests.
- Targeted operational incident tests.
- Typecheck.
- Full fast suite, then full process suite if targeted tests pass.

## Progress

- [x] Existing stall detection, custom Delivery scheduler, protocol validation, and relevant tests inspected.
- [x] Tests added for bounded one-time reminder, successful recovery, and Moderator fallback.
- [x] Implementation complete.
- [x] Documentation updated.
- [x] Targeted validation complete; the intentionally expensive full process suite was replaced by affected-file validation.

## Surprises & Discoveries

- The extra reminder turn exposed a deterministic PTY fixture race: the setup marker became visible before the reminder's Deferred turn settled, so physical input could race active model work. The fixture now waits for reminder transcript evidence and a settled Run without `pending_delivery` before exposing readiness.
- The reminder adds transcript height to the fullscreen PTY view; its scroll assertion must move far enough to reach the same earlier identity evidence.

## Decisions

- Use once per obligation. Request identity is durable and matches the thing that must be discharged; per-Run suppression would repeat noise after failure/restart without changing the obligation.
- Wait for the reminder-triggered turn to settle. Moderator creation on the same boundary would erase the efficiency benefit.
- Prefer one normalized Dependency Deadlock Moderator over member-level reminders. Reminder Delivery temporarily creates a progress source and would otherwise split one closed condition into duplicate incident cycles.

## Outcomes & Retrospective

- A simple Stall now gets one durable, bounded reminder turn per Request identity. An Answer from that turn avoids Moderator creation; a second settlement without an Answer creates the existing Moderator flow.
- Reminder evidence survives later Runs and Stall recurrences through transcript inspection rather than volatile counters.
- Known reminder entries are carried over the process-control protocol and excluded from ordinary Agent Message evidence without weakening rejection of unknown coordination entries.
- Validation passed: TypeScript typecheck, the complete fast suite, all 27 Operational Incident tests, all 13 coordinated PTY tests, and three repeated runs of the exact formerly racing fullscreen PTY test. The full process suite was not rerun after isolation because project policy now directs targeted integration validation for this expensive suite.
