# Agent selector

`/agents` opens a centered custom overlay without replacing the native editor viewport. The fully framed surface is at most 80 columns wide, stays within the terminal height, and shows at most ten roster rows at once. Pi's native `SelectList` owns focus movement, wrapping, and scrolling.

## Live

Live uses one continuous list across three adjacent sections:

- **Attention Inbox** contains Owner-visible Human `DECIDE` items and exhausted Operational `ATTENTION` items. The first attention item receives initial focus. `DECIDE` opens its exact Human Request; Operational `ATTENTION` remains passive.
- **Owner** remains fixed in every Live scope.
- **Agents** contains the current scope's direct ordinary children with current Runs, in creation order.

Right Arrow or `l` enters the focused Agent's child scope. Left Arrow or `h` returns to its parent and refocuses that Agent. Breadcrumbs omit Owner, retain the newest three Agent scopes, and tighten to the available width. Reopening starts in the selected Agent's parent scope so the selected row remains visible.

Enter submits the focused Live Agent to the native session-selection boundary. Selecting a retained live session rebinds Pi's transcript and editor without changing Workflow authority. Enter on `DECIDE` opens its Human Request. Enter on Operational `ATTENTION` does nothing.

## Dormant

Dormant is a flat list of every verified ordinary Agent and Moderator without a current Run. It follows Pi resume recency: latest user or assistant activity, then native session creation time. Moderator rows include their role and compact trigger description.

Moving focus is passive: it does not start a Run, invoke a model, append transcript evidence, or change native selection. Enter submits the durable Agent identity to the same native selection boundary as Live. That boundary may bind an inspectable transcript, but the selector never starts work.

## Focused details and keys

The focused row always reserves four detail lines:

1. optional description;
2. full Agent identity;
3. Dormant or current Run semantics with compact Retention Reasons;
4. provider/model, thinking level, and queued-input count.

An absent description leaves its line empty, keeping the overlay height stable as focus moves.

- Tab or Shift-Tab: switch Live and Dormant
- Up/Down or `k`/`j`: move focus
- Right/Left or `l`/`h`: enter or leave a Live Agent scope
- Enter: perform the focused row's action
- Escape: close
