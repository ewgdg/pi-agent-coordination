# In-process SDK Agent supervisor prototype

This throwaway prototype asks whether normal Pi can keep Owner and directly
spawned SDK `AgentSession`s alive in one process while the native interactive UI
switches among them. The design should preserve Pi's transcript and tool
renderers, editor, queues, history, Vim integration, working indicator, footer,
and extension UI without a wrapper executable or child worker process.

## Run

Install the pinned dependencies once with `npm install`, trust this worktree when
Pi asks, then launch it normally:

```sh
pi
```

Use `/agents` to open a bounded, fully framed overlay and switch among Owner and
the fixed nested roster. Researcher owns Source Scout and Synthesizer; Builder
owns Reviewer. Owner stays in its own fixed section; the zoomed Agent roster
contains only the current scope's direct children. Right Arrow or `l` zooms into
a highlighted Agent's children; Left Arrow or `h` returns to its parent. The
Up/Down arrows or `k`/`j` move through the current list. The breadcrumb omits
Owner and shows at most the three most recent Agent scopes,
using `…` when older ancestors are hidden and dropping additional old scopes on
narrow terminals. Enter switches to the highlighted Agent without changing its
navigation meaning. Reopening `/agents` starts at the selected Agent's parent
scope so the current selection remains visible. The overlay scrolls long sibling
rosters without resizing the editor. The cursor-focused entry expands by two
fixed rows: short session identity and role description, followed by
provider/model, thinking level, and queued-message count. The two-row budget is
constant, so moving focus does not resize the overlay. Switching does not stop
an active Agent. Pending Attention Inbox entries appear first as
`DECIDE · Agent` shortcuts; selecting one switches directly to that Agent. The
Attention Inbox, Owner, and Agent roster render as separate stacked sections
while sharing one native selection flow. When attention exists, the cursor
starts on its first item so Enter switches immediately to the requester;
otherwise it starts on the current Agent. The overlay is capped at 80 columns,
shrinks to narrower terminals, and centers its natural-width content block.
Ctrl-D performs the final coordinated shutdown.

In a child session, run `/prototype-human-request [question]` to exercise the
Human Request bridge. The Owner alone shows a DECIDE item in its Attention Inbox.
Switch to the requesting child and submit the answer through its normal editor.
The question and answer use Pi's native assistant and user transcript rendering.

The prototype intentionally fails at startup unless the host Pi version is
`0.82.1`; it relies on that version's private runtime shape.

## What to exercise

- Start work in Researcher, switch to Owner while Researcher is active, and send
  Owner a prompt immediately.
- Return to Researcher and inspect its continued transcript and native tool
  rendering.
- While an Agent streams, use Enter for steering, Alt+Enter for follow-up, and
  Alt+Up to restore queued messages.
- Confirm editor history and Pi Vim still behave normally after switching.
- Select Researcher and Builder in turn. Confirm the above-editor activity view
  shows only that selected Agent's direct children, while leaf Agents show no
  child activity view.
- In `/agents`, confirm Owner remains in its own section while the Agent roster
  zooms from Owner's children into Researcher's children and back. Switch to
  Source Scout, reopen the menu, and confirm the roster starts at the Researcher
  scope with Source Scout selected.
- Move the `/agents` cursor across Attention, Owner, and Agent rows. Confirm the
  two detail rows follow focus without changing the overlay height.
- Exercise a Human Request while viewing Owner, then answer it from the
  requesting child. Confirm only the footer's `waiting (human)` phase becomes
  warning-colored before returning to dim `idle`, and Owner attention clears.
- Exit with Ctrl-D and confirm no process from this prototype session remains.

## Current verdict

The real-terminal visual and interaction design is accepted. The selector uses
compact adjacent sections, native list behavior with arrow and Vim navigation,
scoped child zoom, and stable label-aligned focus details.

The selected session is exposed directly to Pi's `InteractiveMode`; transcript
projection and editor interception are absent. Retained sessions continue in
memory while deselected, and input collection remains available when another
session is active. Each session receives one startup event, refreshed host UI
bindings when selected again, and one quit event before final disposal. Switching
Agents rebuilds the selected Agent's native terminal frame and scrollback so its
editor and footer remain at the live terminal bottom.

The extension adds one restrained selected-child status segment after Pi's
native footer: `name · short-session-id · phase`. Normal phases are dim; a Human
Request colors only `waiting (human)` as a warning. Model and thinking details
remain exclusively in Pi's native footer.

This is a fixed, in-memory experiment. Nested ownership is predefined so the UI
and session-switching behavior can be exercised; it does not yet prove dynamic
spawning. It is not production architecture and does not define persistence.
