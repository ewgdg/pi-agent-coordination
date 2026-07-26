# PROTOTYPE — live polling and idempotent retry

This throwaway logic prototype asks whether a volatile live scheduler can provide coherent delivery without a durable mailbox, replay, or another source of truth. The sender transcript owns the immutable message and retry records. The recipient transcript alone proves delivery to that Agent identity. Polling reads that recipient proof directly. A recipient Run crash rejects and discards an admitted volatile delivery before commit; restarting performs no replay. A retry preserves the message identity and either schedules another delivery or discovers the existing proof.

There is deliberately no protocol-level `attemptId`. `messageId` is the idempotency key. Each send or retry already has a native sender transcript entry identity, and recipient delivery points to that entry. A scheduler may use an ephemeral run-local correlation token internally, but it is not canonical protocol data.

Run:

```sh
npm run prototype:live-retry
```

Suggested path through the model:

1. `s` — commit and schedule the original message.
2. `x` — crash the recipient Run before delivery; observe the failed attempt and empty volatile scheduler.
3. `p` — poll; observe that no recipient delivery proof exists.
4. `u` — restart the recipient Run; observe that nothing replays.
5. `r` — retry with the same message identity.
6. `d` — commit delivery to the recipient transcript.
7. `p` — poll; observe proof tied to the recipient Agent identity.
8. `r` — retry again; observe that existing proof prevents duplicate scheduling.

To exercise the in-flight race without an `attemptId`, reset with `0`, then use `s`, `r`, `d`, `d`. Both volatile deliveries coexist and are distinguished by their sender transcript source entries. The first recipient commit wins by `messageId`; the second is suppressed without creating another delivery entry.

The restart action is only an environmental control for this prototype. It does not decide Idle-close or Run-restart serialization, which belongs to the separate Wayfinder decision “Prove Idle closure and message-triggered Run restart serialization.”
