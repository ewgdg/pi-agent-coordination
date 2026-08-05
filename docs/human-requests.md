# Human Requests

Any ordinary Agent can call `ask_user_question` to ask the human one or more structured Questions and block its current Run until the native tool call succeeds or is interrupted.

```ts
ask_user_question({
  questions: [
    {
      kind: "select_one",
      header: "Boundary",
      prompt: "Which boundary should remain authoritative?",
      options: [
        { label: "Native Pi", description: "Use the native tool result." },
        { label: "Separate store" }
      ],
      allowOther: false
    },
    {
      kind: "select_many",
      header: "Validation",
      prompt: "Which checks should run?",
      options: [
        { label: "Real session" },
        { label: "PTY" }
      ],
      allowOther: true
    },
    {
      kind: "text",
      header: "Rationale",
      prompt: "Why?",
      multiline: true
    }
  ]
})
```

Every request contains at least one Question. Headers, prompts, option labels, option descriptions, custom values, and text Answers must contain non-whitespace text. Select Questions require at least one unique option. `allowOther` controls whether the human may provide a custom value.

Questions, options, and Answers correlate by array position. A complete Answer contains one matching Answer for every Question:

```json
{
  "requestId": "...",
  "answers": [
    { "kind": "select_one", "selectedOptionIndex": 0 },
    {
      "kind": "select_many",
      "selectedOptionIndexes": [0],
      "customValue": "Package dry run"
    },
    { "kind": "text", "text": "The transcript remains authoritative." }
  ]
}
```

A select-one Answer contains either one zero-based `selectedOptionIndex` or one allowed `customValue`. A select-many Answer contains unique zero-based `selectedOptionIndexes` and may also contain one allowed `customValue`; at least one listed or custom choice is required.

## Native interaction

The Owner's own request opens immediately. A background Agent's request adds passive `DECIDE` attention without taking focus. Use `/agents` and select the numbered `DECIDE` row to open that request.

The request surface has one tab per Question. Use Tab or Left/Right to change Questions, Up/Down to move through options, Space to toggle select-many options, Enter to confirm, and Escape to interrupt. Partial selections remain only in the open surface. Pi preserves the native editor contents while the surface is open and restores the editor when it closes.

## Commitment and scheduling

The committed `ask_user_question` call is the Human Request. Its matching successful native tool result is the sole Human Answer. UI submission is only a candidate: `input_required` attention remains until that exact result is present in the transcript.

The tool runs sequentially, so later sibling calls wait for the Answer or interruption. Steer Messages wait for successful Answer commitment. Deferred Messages wait until the answered turn settles. Other Agent Messages cannot answer a Human Request.

Escape aborts the exact live invocation and records one matching error tool result. A Run failure that fences the interaction before successful result commitment also closes the surface and rejects late input. Pending interaction state and drafts are volatile; a successor Run does not reconstruct the request.
