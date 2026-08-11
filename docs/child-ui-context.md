# Child UI context

Every non-Owner ordinary Agent and Moderator runs in a fresh Pi CLI process with a real pseudoterminal. The child owns one `AgentSessionRuntime`, one `AgentSession`, one fullscreen `InteractiveMode`, and the live session JSONL. Its extension context is truthful: `ctx.mode === "tui"` and `ctx.hasUI === true`.

The Owner process remains the Workflow authority. It owns scheduling, retention, Requests, Messages, Operational Incidents, child process supervision, and the physical human attachment.

## Per-Agent presentation

A child process owns its transcript components, editor, footer, statuses, widgets, notifications, selectors, dialogs, commands, shortcuts, tools, pending state, and focused overlays. Extension UI calls affect only that process. Child theme state, extension globals, signal handlers, listeners, and environment mutation cannot alter the Owner process or another Agent.

The child TUI writes ANSI output to its PTY. The Owner reconstructs the active terminal frame with `@xterm/headless` and presents it through the common Terminal Projection interface. Physical input, paste, mouse bytes, generated terminal replies, and resize use the PTY path; structured coordination never enters terminal traffic.

Opening an Agent view attaches the Workflow-global human attachment to the existing process projection. It does not rebind the Owner session or copy child UI state into the Owner TUI. Closing the view removes `interactive_selection` retention. A retained child process can continue running while unselected; an eligible settled Runtime exits and is recreated from its committed blueprint when later work arrives.

## Child `/agents`

The Runtime Bridge registers `/agents` inside every process child. It requests a scoped selector snapshot from the Owner containing the live and dormant roster, selected Agent, Human Attention, and Operational Attention. The child renders the normal selector through its own `ctx.ui`.

Selection remains authoritative in the Owner:

- selecting Owner closes the active attachment without terminating the child Run;
- selecting another Agent retargets the same attachment to that Agent's PTY projection;
- selecting the current child closes the selector and keeps the attachment;
- cancellation leaves the current attachment unchanged;
- stale Human Attention or focus failure restores the previous selection.

Input and resize continue through the newly selected projection after retargeting. Escape remains child UI input and is not repurposed as a hidden return key.

## Runtime preparation and Run admission

Agent Identity, the role bootstrap, and one immutable Runtime Blueprint commit before process launch. The Owner materializes that evidence to the exact session JSONL, drops its staging writer, and then launches the exact installed Pi CLI with explicit cwd, model, thinking, tools, skill paths, file-backed extensions, context artifact, trust decision, and session path.

The process may be prepared before model work. Extension `session_start` behavior remains native: dialogs and overlays can appear before Run admission, and extension-emitted user input activates work normally. Prompt acceptance is not settlement; the Owner changes Run state only from the awaited child lifecycle and durable transcript evidence, with `agent_settled` as the authoritative settlement boundary.

A startup cancellation owns the exact process group. If graceful child shutdown cannot complete, the Owner force-kills the process group and waits for exact PTY exit. A pre-admission kill is not required to emit Pi `session_shutdown`; process exit and artifact cleanup are the authoritative evidence.

## Isolation from the physical pane

Children inherit ordinary provider, proxy, locale, and home-directory environment, but never inherit `HERDR_ENV`, `HERDR_SOCKET_PATH`, or `HERDR_PANE_ID`. A file-backed Herdr extension may load in the child, but without physical-pane ownership it remains inert. Only the Owner reports lifecycle state for the Herdr pane.
