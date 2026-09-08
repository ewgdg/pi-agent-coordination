# Trusted committed delivery receipts (#97)

## Goal and intention
Treat correctly associated committed model-visible transcript records as delivery receipts, without revalidating source text.

## Scope and constraints
Narrow inspection inputs to identity/correlation. Preserve source, sender, recipient/current scope, kind, related Request, exact schemas, duplicates and lifecycle policies. No new durable stores or broad refactors.

## Work plan
1. Add regression tests before implementation.
2. Replace payload comparisons with explicit association checks; remove inspection-only content plumbing.
3. Document semantics and run focused protocol/lifecycle tests and typecheck.

## Validation
Content differences accepted for all four Message kinds, Creation Requests and Answer retrievals; mismatched associations rejected. Existing writer/public contract and lifecycle tests retained.

## Progress
- Read issues #97/#94 and traced delivery parsing, retained current-scope indexes, Creation Request and retrieval callers.
- Deep equality currently also checks kind, identity, sender and related Request; these must remain explicit.

## Decisions
Keep exact parsing and duplicate policy unchanged. No performance claim: this is a semantics/plumbing simplification.

- Added a content-divergence regression before source edits; observed failure at the old deep equality check.
- Implemented identity-only inspection and removed Creation Request question plumbing and retrieved Answer text comparison. Writer projections and parsing remain unchanged.
- Added coverage for all kinds, source/kind/sender/identity/related Request mismatch, wrong recipient, scope replacement, exact schemas, visibility, duplicates, Creation writer fidelity and Answer retrieval.

## Outcomes and validation
- Typecheck and diff whitespace validation pass.
- Focused message-delivery/message/request-evidence/wait-request-recovery run: 67/67 passed (31.5 seconds).
- Final message-delivery/agent-transcript run: 26/26 passed, including incomplete-entry/cursor coverage.
- Selected agent-spawn run: 4 passed, 2 failed. Both failures reproduced with all five modified source files restored to HEAD: the isolated-child test reads undefined context messages at line 173; the forged-receipt harness test misses its expected rejection at line 1367. These pre-existing harness failures were not expanded into unrelated repairs. A direct Creation Request wrong-identity regression covers the inspection contract.
- No full suite, push or PR. No measured performance benefit claimed.

## Risks and retrospective
Receipt inspection intentionally cannot detect altered-but-readable text; fidelity is a writer/public contract. Existing current-scope indexes remain responsible for Workflow isolation and cursor lifecycle. The two baseline spawn harness failures limit integration evidence, but focused retry and Creation Request lifecycle cases passed.
