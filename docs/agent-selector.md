# Agent selector and view

`/agents` first opens a centered roster overlay. The framed selector is at most 80 columns wide, stays within the terminal height, and shows at most ten roster rows at once. Pi's native `SelectList` owns focus movement, wrapping, and scrolling.

Selecting a non-Owner row opens that durable Agent's full-window interactive view. The Owner's native runtime session, services, diagnostics, transcript container, editor implementation and text, footer, and extension UI context remain mounted underneath. Selecting Owner returns to that exact existing Owner presentation.

Agent selection prepares the target mode before dismissing the roster. The selector retains input focus during asynchronous preparation, so typing, paste, Enter, or Escape cannot fall through to the Owner editor between selection and child attachment.

## Live roster

Live uses one continuous list across three adjacent sections:

- **Attention Inbox** contains Owner-visible Human `DECIDE` items and exhausted Operational `ATTENTION` items. The first attention item receives initial focus. `DECIDE` opens its exact Human Request; Operational `ATTENTION` remains passive.
- **Owner** remains fixed in every Live scope.
- **Agents** contains the current scope's direct ordinary children in creation order. Live Moderators appear at the Owner scope as standalone participants.

Right Arrow or `l` enters the focused ordinary Agent's child scope. Left Arrow or `h` returns to its parent and refocuses that Agent. Breadcrumbs omit Owner, retain the newest three Agent scopes, and tighten to the available width.

Opening a live Agent view attaches the exact Run's complete Pi mode. The Run gains `interactive_selection` retention while selected. Returning to Owner or switching Agents removes that retention and permits ordinary release when no other Retention Reason remains. View attachment never owns or disposes a live projection; exact Run teardown retains that responsibility.

## Dormant roster

Dormant is a flat list of every verified ordinary Agent and Moderator without a current Run. It follows Pi resume recency: latest user or assistant activity, then native session creation time. Moderator rows include their role and compact trigger description.

Selecting a Dormant Agent starts exactly one successor Run with `interactive_selection` retention and attaches its complete live mode. Selection submits no model input and appends no user evidence; it only activates the normal session, coordination tools, commands, shell input, custom extensions, editor, and footer that the selected Agent needs for interaction.

The selector keeps focus while the successor starts. Its initializing mode is attached before `session_start` UI settles, so a startup dialog remains operable without admitting model work. A concurrent ordinary Message uses the same serialized successor rather than starting another Run. Returning to Owner or switching Agents removes selection retention and permits ordinary release when no other Retention Reason remains.

## Full-window Agent view

The fixed one-row outer header identifies the durable Agent by label, compact identity, and Live or Dormant phase. The remaining rows contain the child mode's complete Pi fullscreen frame: transcript, pending and working state, tool rendering, widgets, editor, footer, notifications, selectors, dialogs, and child-local extension overlays.

All input is routed through the child TUI's detached terminal. Printable text, paste, completion, commands, extension shortcuts, custom editors, and focused child overlays behave as they do in native Pi. The outer view does not steal Escape; custom editors such as pi-vim keep their normal Escape semantics.

`/agents` remains available inside the child mode:

- select Owner to return to the exact mounted Owner presentation;
- select another Agent to retarget the same full-window attachment without exposing the Owner editor; or
- select the current Agent to keep the existing mode.

Pi's fullscreen transcript viewport and editor dock coexist. Page Up/Page Down, Home/End, configured prompt navigation, and mouse scrolling move the transcript while the editor remains available. At the tail, new output follows automatically. Scrolling away preserves the inspected region until the native end action restores tail following. Resize updates the detached terminal and reflows the complete child frame within the available rows.

A terminally failed selected Run transitions to a complete Dormant failure presentation without closing the overlay. Explicit human input or ordinary coordination may start a later successor and replace that fallback mode in the same durable attachment. Switching or Workflow-driven disposal settles the attachment once, releases live selection retention, disposes view-owned failure-presentation resources, and restores the untouched Owner when appropriate.

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
