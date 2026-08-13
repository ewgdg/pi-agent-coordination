# Agent selector and view

`/agents` first opens a centered roster overlay. The framed selector is at most 80 columns wide, stays within the terminal height, and shows at most ten roster rows at once. Pi's native `SelectList` owns focus movement, wrapping, and scrolling.

Selecting a non-Owner row opens that durable Agent's full-window interactive view. The Owner's native runtime session, services, diagnostics, transcript container, editor implementation and text, footer, and extension UI context remain mounted underneath. Selecting Owner returns to that exact existing Owner presentation.

Agent selection prepares the target mode before dismissing the roster. The selector retains input focus during asynchronous preparation, so typing, paste, Enter, or Escape cannot fall through to the Owner editor between selection and child attachment.

## Live roster

Live uses one continuous list across three adjacent sections:

- **Attention Inbox** contains Owner-visible Human `DECIDE` items and exhausted Operational `ATTENTION` items. A `DECIDE` row identifies the requesting Agent and shows a bounded one-line question preview. The first attention item receives initial focus. Selecting `DECIDE` opens that Agent's full-window view at its pending request and focuses its native editor. Selecting an Operational `ATTENTION` item with exactly one affected Agent opens that Agent's full-window view without changing the incident. Multi-Agent attention remains informational, and Enter leaves the selector open.
- **Owner** remains fixed in every Live scope.
- **Agents** contains the current scope's direct ordinary children in creation order. Live Moderators appear at the Owner scope as standalone participants.

Right Arrow or `l` enters the focused ordinary Agent's child scope. Left Arrow or `h` returns to its parent and refocuses that Agent. Breadcrumbs omit Owner, retain the newest three Agent scopes, and tighten to the available width.

Opening a live Agent view attaches its Agent Runtime's complete Pi mode. `interactive_selection` retains that Runtime and protects its exact current Run from ordinary termination, but does not itself admit or prolong a Run. Returning to Owner or switching Agents removes Runtime retention; an unselected Dormant Runtime is then disposed, while live work follows ordinary Run retention.

## Dormant roster

Dormant is a flat list of every verified ordinary Agent and Moderator without a current Run. It follows Pi resume recency: latest user or assistant activity, then native session creation time. Moderator rows include their role and compact trigger description.

Selecting a Dormant Agent prepares its ordinary configured Agent Runtime over persisted evidence. The same session supplies its configured tool allowlist, extension-controlled active tools, extensions, editor, footer, commands, shortcuts, and extension UI before and during later work. Selection itself does not admit a Run, initialize Run-scoped Request relationships, invoke the model, or append transcript evidence; observation remains `phase: "dormant"`.

The selector keeps focus while the Runtime is prepared. Its mode is attached before `session_start` UI settles, so startup dialogs remain operable. Extension lifecycle behavior is not filtered: `session_start`, slash commands, shortcuts, and other extension actions keep their normal semantics, and any resulting Agent work activates a Run in this same Runtime. UI-only commands leave the Agent Dormant. Editor input and ordinary coordination Delivery likewise activate the same Runtime without replacing its projection or replaying `session_start`. Closing, switching, or Workflow shutdown cancels pending initialization and disposes a never-activated Runtime after removing selection retention.

If a Dormant Agent's current configured Runtime cannot be prepared before any usable projection exists, selection opens an Owner-hosted read-only post-mortem view over one coherent snapshot of that Agent's durable active transcript. Acquisition is single-pass: a successful prepared Runtime is used directly rather than probed and reopened. The file-backed snapshot parser migrates only an in-memory clone, so opening legacy or empty evidence cannot rewrite it. Before native text components receive the snapshot, all evidence-derived strings are stripped of terminal controls and image payloads are disabled. The fallback admits no Run, creates no Runtime or retention, appends no evidence, and does not mark the durable Agent failed. It shows the preparation error separately from the transcript. For child-origin selection, the Owner temporarily resumes its TUI while preserving the exact selected child projection for restoration; Control carries only a bounded outcome and no transcript path or contents. Up/Down or `j`/`k` scroll one line, Page Up/Page Down scroll one page, Home/End jump to the boundaries, `a` opens `/agents`, and Escape or `q` restores the exact previously mounted Owner or Agent presentation.

## Full-window Agent view

The attachment adds no fixed header. It suspends Owner rendering and presents the selected child PTY directly, so the physical terminal receives the child mode's complete native Pi fullscreen output: transcript, pending and working state, tool rendering, widgets, editor, footer, notifications, selectors, dialogs, and child-local extension overlays.

A scoped activity dock lives inside the native above-editor widget area. For a selected non-Owner Agent, its first row is `label · compact Agent ID · status`; the label is accented and bold, the identity is dim, and only the status receives its semantic status color. Rendered statuses are lowercase: `dormant` when no exact Run exists, `active` while a Run executes work, `idle` when a current Run is settled, `waiting` with a named reason when progress needs human input, an Agent answer, or resumption, and `starting`, `ending`, or `failed` during those lifecycle conditions. While the selected Agent awaits a Human Answer, the dock also shows `ANSWER · Enter submits` directly above the unchanged native editor.

With Owner selected, the dock shows the Owner-only Attention Inbox before Owner's direct children that have a current Run. With another Agent selected, it shows only that Agent's identity and direct children that have a current Run. Starting, live, and ending child rows stay in creation order and project Run state, attention, model/thinking configuration, and queued-input count. Each dock section shows its first three rows; when more exist, a final dim `… N more` row reports the hidden remainder. Dormant Agents remain available through `/agents` but do not appear in the activity dock. Human `DECIDE` and exhausted operational `ATTENTION` occur only in the Owner dock; `/agents` retains every attention item and its existing action.

All input is routed directly to the selected child PTY. Printable text, paste, completion, commands, extension shortcuts, custom editors, and focused child overlays behave as they do in native Pi. The attachment does not steal Escape; custom editors such as pi-vim keep their normal Escape semantics.

`/agents` remains available inside the child mode:

- select Owner to return to the exact mounted Owner presentation;
- select another Agent to retarget the same full-window attachment without exposing the Owner editor; or
- select the current Agent to keep the existing mode.

Pi's fullscreen transcript viewport and editor dock coexist. Page Up/Page Down, Home/End, configured prompt navigation, and mouse scrolling move the transcript while the editor remains available. At the tail, new output follows automatically. Scrolling away preserves the inspected region until the native end action restores tail following. Resize updates the selected PTY and lets the child TUI reflow its complete native frame within the available rows.

A terminally failed selected Run leaves the same Agent Runtime and full-window view in place while the Agent becomes Dormant. The failed transcript remains visible. Explicit input, extension effects, or ordinary coordination may activate a successor in that Runtime without replacing the projection. Switching or Workflow-driven disposal settles the attachment once, removes Runtime retention, and restores the untouched Owner when appropriate.

## Focused roster details and keys

The focused roster row reserves four detail lines:

1. optional description;
2. full Agent identity;
3. Dormant or current Run semantics with compact Retention Reasons;
4. provider/model, thinking level, and queued-input count.

An absent description leaves its line empty, keeping the overlay height stable as focus moves.

- Tab or Shift-Tab: switch Live and Dormant
- Up/Down or `k`/`j`: move focus
- Right/Left or `l`/`h`: enter or leave a Live ordinary-Agent scope
- Enter: perform the focused row's action
- Escape: close the selector
