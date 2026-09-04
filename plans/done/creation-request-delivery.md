# Creation Request delivery after rejected tool calls

## Goal and scope

Prevent an invalid model-emitted Agent Message call from blocking unrelated Creation Request delivery before Pi commits its validation result. Make pre-dispatch admission failure recoverable and ensure duplicate admission cannot preserve abandoned scheduling. Preserve exact Message identity, transcript-authoritative Delivery proof, and invariant errors for contradictory evidence.

Moderator detection is separate work in #89. Do not change unrelated presentation, templates, or runtime policy. Base: `cc9e5395c0ae28168ed71196daf6f783e78d6b57`.

## Agreed public seams

- Pi session tool/lifecycle boundaries and authenticated WorkflowCoordinator participant operations, with durable recipient transcript evidence and Agent status as observable contracts.
- Existing fault-injection hooks may control boundary failures without replacing coordination collaborators.
- Protocol transcript inspection for malformed authorship and contradictory result evidence.

## Work plan

1. Reproduce the malformed-call/validation-result gap while creating another Agent. Assert initial Request delivery exactly once.
2. Exclude invalid, unaccepted calls from authored protocol facts while retaining contradiction checks.
3. Reproduce pre-dispatch admission failure and retry. Clean abandoned scheduling without erasing a canonical child or Request, and preserve dispatched reservations/uncertainty.
4. Document the contract, review Standards and Spec independently, and address findings within scope.
5. Run focused process/protocol tests, typecheck, and package validation; commit and open a separate PR.

## Validation

Use deterministic provider fixtures and controlled lifecycle gates. Run only relevant test files or named cases while iterating, with process tests sequentially. At completion run affected spawn, message, Request, and protocol coverage plus typecheck and package dry-run. Do not run the full suite.

## Progress

- Created isolated worktree and branch from origin/main, matching the diagnosed commit.
- Installed the pinned lockfile in this worktree without changing manifests or the other agent's working directory.
- Native lifecycle regression failed with the reported ProtocolInvariantError, then passed after excluding invalid calls before their result append.
- Pre-dispatch failure regression reproduced a settled live child retained by pending delivery, then passed with cleanup and successful explicit retry.
- Pending-retry regression timed out before the change, then delivered exactly once after rechecking eligibility, including a late original dispatch callback.
- Focused protocol tests passed; successful-result contradiction coverage remains intact. Typecheck passed.
- Independent Standards review passed. Spec review requested cross-Agent native timing coverage; the strengthened test passes and the reviewer confirmed the finding is resolved.
- Final targeted run passed all four delivery, retry, and malformed-call polling cases. Protocol and Message Delivery tests passed 15/15.
- Affected spawn coverage passed 26/27. The remaining test expects a native tool list without `powershell`; the identical assertion fails on untouched base with the same pinned dependencies. No unrelated tool-list change is included.
- Message and Request coverage passed 65/66 on its broader run. The remaining test encoded the old malformed-call behavior; its corrected contract now passes the final targeted run, including contradictory-success rejection.
- Final typecheck and package dry-run passed. The full project suite was not run, per repository policy.

## Evidence and decisions

The saved-transcript replay showed RequestEvidence throwing during the interval between an invalid call and its error result. Real MessageCoordinator admission retained pending delivery after the exception, and duplicate admission returned pending with no dispatch. These observations guide regression tests; tests must not depend on the user's saved sessions.

The final native regression holds an invalid Owner call before Pi validation while a distinct Agent uses its native spawn tool to create a leaf. It verifies the leaf's spawner identity and one initial delivery. The same test fails on the untouched base with the reported invariant error. It waits for native Answer receipts before teardown so fixture shutdown does not race unfinished tool execution.

## Outcome

The delivery fix is implemented and independently reviewed in its isolated branch, ready for PR handoff. Invalid unaccepted calls no longer block unrelated protocol inspection. Pre-dispatch failure releases abandoned scheduling while retaining the canonical child and Request; explicit retry rechecks pending work without duplicating dispatched work. Moderator detection remains in #89.
