# Agent selector

`/agents` opens a centered custom overlay without replacing the native editor viewport. The fully framed surface is at most 80 columns wide, stays within the terminal height, and shows at most ten roster rows at once. Pi's native `SelectList` owns focus movement, wrapping, and scrolling.

## Live

Live uses one continuous list across three adjacent sections:

- **Attention Inbox** contains Owner-visible Human `DECIDE` items and exhausted Operational `ATTENTION` items. The first attention item receives initial focus. `DECIDE` opens its exact Human Request; Operational `ATTENTION` remains passive.
- **Owner** remains fixed in every Live scope.
- **Agents** contains the current scope's direct ordinary children with current Runs, in creation order.

Right Arrow or `l` enters the focused Agent's child scope. Left Arrow or `h` returns to its parent and refocuses that Agent. Breadcrumbs omit Owner, retain the newest three Agent scopes, and tighten to the available width. Reopening starts in the selected Agent's parent scope so the selected row remains visible.

Enter submits the focused Live Agent to the native session-selection boundary. Selection belongs to the durable Agent; its current Run session is only the replaceable presentation binding. Selecting a live Agent rebinds Pi's transcript and editor without changing Workflow authority and retains that exact Run. Enter on `DECIDE` opens its Human Request. Enter on Operational `ATTENTION` does nothing.

While a non-Owner Agent is selected, Pi's native footer keeps one extension-status slot with the Agent label, compact identity, and current semantic Run state. The selected Agent label is accented and bold for non-failed states; an active Run also prefixes it with `●`. Compact identity and ordinary states remain dim, `waiting (human)` is the only warning state, and a currently observable failed Run uses error emphasis. Selecting Owner clears the slot. This footer projection is independent of the scoped activity panel.

## Dormant

Dormant is a flat list of every verified ordinary Agent and Moderator without a current Run. It follows Pi resume recency: latest user or assistant activity, then native session creation time. Moderator rows include their role and compact trigger description.

Moving focus is passive: it does not start a Run, invoke a model, append transcript evidence, or change native selection. Enter selects the durable Agent and binds a presentation-only session to its existing transcript and native editor. That binding registers only `/agents` and the native input router; other prompt sources are handled without model invocation, and no coordination tools are present. It is neither a Run nor a coordination writer.

The first native editor Message starts one successor in the selected Agent's serialized lane, replaces the presentation binding with the fresh Run session, and commits the exact input once before execution. An ordinary Message that starts a selected Agent also replaces the binding automatically. Terminal Run failure preserves selection by returning to a Dormant presentation without replaying work; later editor input or ordinary Message may start the successor.

Selecting the same Agent is a no-op only while Pi already holds its current presentation binding. Enter repairs a stale session incarnation while preserving the Agent selection.

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
