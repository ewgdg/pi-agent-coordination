# Child UI context

Every non-Owner ordinary Agent and Moderator runs in a fresh Pi CLI process with a real pseudoterminal. The child owns one `AgentSessionRuntime`, one `AgentSession`, one fullscreen `InteractiveMode`, and the live session JSONL. Its extension context is truthful: `ctx.mode === "tui"` and `ctx.hasUI === true`. During public TUI session binding, the Runtime Bridge associates Pi's public Runtime registration with the exact `SessionManager`. A zero-line extension widget receives and retains Pi's stable public `TUI` reference for physical presentation handoff.

The Owner process remains the Workflow authority. It owns scheduling, retention, Requests, Messages, Operational Incidents, child process supervision, and the physical human attachment.

## Per-Agent presentation

A child process owns its transcript components, editor, footer, statuses, widgets, notifications, selectors, dialogs, commands, shortcuts, tools, pending state, and focused overlays. Extension UI calls affect only that process. Child theme state, extension globals, signal handlers, listeners, and environment mutation cannot alter the Owner process or another Agent.

Process-local UI state is isolated, but user preferences are shared. Every Runtime uses the same Pi user configuration: an explicit preference action in a selected child view persists exactly as it would in the Owner view, while the model, explicit thinking level, and resources chosen during Runtime Preparation remain launch inputs and must not change those preferences. A Moderator without a Template model selection leaves thinking unset so Pi reads that shared default without copying the Owner's effective level. See [ADR 0001](adr/0001-share-pi-user-configuration-across-agent-runtimes.md).

The child TUI writes ANSI output to its PTY. The child environment declares `TERM=xterm-256color` and `COLORTERM=truecolor`, matching the owned xterm.js terminal's indexed- and 24-bit-color support rather than inheriting the Owner terminal's capability declaration. While detached, `@xterm/headless` keeps terminal state for diagnostics and recovery. While selected, the Owner suspends its own TUI and forwards the child's raw PTY output directly to the physical terminal; physical input, paste, mouse bytes, terminal replies, and resize travel directly between that terminal and the selected child PTY. Structured coordination never enters terminal traffic.

Opening an Agent view attaches the Workflow-global human attachment to the existing process projection and asks the child to reinitialize its native TUI. Handoff output and physical input remain buffered until reinitialization completes, then Pi's ordered native output establishes the alternate-screen, mouse, paste, keyboard, cursor, and complete redraw state required by the physical terminal. If the physical output sink applies backpressure, the Owner pauses and resumes the selected child PTY instead of accumulating an unbounded live-output queue. Returning to Owner resets the physical terminal, restarts the exact mounted Owner TUI, and forces a complete Owner redraw. This does not rebind the Owner session or copy child UI state into the Owner TUI. Closing the view removes `interactive_selection` retention. A retained child process can continue running while unselected; an eligible settled Runtime exits and later work creates a fresh process from a newly resolved launch specification.

## Child `/agents`

The Runtime Bridge registers `/agents` inside every process child. It requests a scoped selector snapshot from the Owner containing the live and dormant roster, selected Agent, Human Attention, and Operational Attention. The child renders the normal selector through its own `ctx.ui`.

Selection remains authoritative in the Owner:

- pressing `o` closes the active attachment without terminating the child Run;
- selecting another Agent retargets the same attachment to that Agent's PTY projection;
- selecting the current child closes the selector and keeps the attachment;
- cancellation leaves the current attachment unchanged;
- stale Human Attention or focus failure restores the previous selection.

Input and resize continue through the newly selected projection after retargeting. Escape remains child UI input and is not repurposed as a hidden return key.

## Runtime preparation and Run admission

Only Agent Identity or Moderator Input bootstrap evidence commits before process launch. The Owner dynamically resolves the current parent configuration, Template, explicit spawn input, resources, trust, native project-context inheritance, and explicit system prompt into a volatile launch specification. It materializes the bootstrap evidence to the exact session JSONL, drops its staging writer, and launches the exact installed Pi CLI with the prepared cwd, model, thinking, tool allowlist, skill paths, file-backed extensions, explicit system prompt artifact when configured, trust decision, and session path. Extensions control the active subset and its order inside that ceiling. The launch specification uses native project context discovery when `inheritProjectContext` is true, and passes the explicit child system prompt with its independent `systemPromptMode`. A replacement child can disable native context files with `inheritProjectContext: false`. The launch specification is not transcript evidence and is resolved again for every successor Runtime.

The process may be prepared before model work. Extension `session_start` behavior remains native: dialogs and overlays can appear before Run admission, and extension-emitted user input activates work normally. Prompt acceptance is not settlement; the Owner changes Run state only from the awaited child lifecycle and durable transcript evidence, with `agent_settled` as the authoritative settlement boundary.

A startup cancellation owns the exact process group. If graceful child shutdown cannot complete, the Owner force-kills the process group and waits for exact PTY exit. A pre-admission kill is not required to emit Pi `session_shutdown`; process exit and artifact cleanup are the authoritative evidence.

## Isolation from the physical pane

Children inherit ordinary provider, proxy, locale, and home-directory environment, but never inherit `HERDR_ENV`, `HERDR_SOCKET_PATH`, or `HERDR_PANE_ID`. A file-backed Herdr extension may load in the child, but without physical-pane ownership it remains inert. Only the Owner reports lifecycle state for the Herdr pane.
