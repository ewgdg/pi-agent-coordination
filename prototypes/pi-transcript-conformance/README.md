# PROTOTYPE — Pi transcript conformance

## Question

Can an SDK-hosted extension on `@earendil-works/pi-coding-agent` 0.82.0 observe the tool-call, tool-result, custom-message, settlement, compaction, and tree-navigation commit boundaries needed by live coordination, persist a restart-safe branch marker, and expose any remaining seam that would require a Pi-core change?

This is a throwaway executable probe, not production code. It uses a deterministic fake model and scratch Pi sessions under the operating system's temporary directory; it makes no provider requests.

## Run

```bash
npm install
npm run prototype:pi-transcript
```

The interactive frame can rerun the suite and show the captured hook timeline. For automated verification:

```bash
npm run prototype:pi-transcript -- --all
```
