# Child UI context

Each hosted ordinary Agent or Moderator can own one complete Pi `AgentSession` and `InteractiveMode`. Together they form the Agent Runtime. The Runtime can be prepared while the Agent is Dormant; a Run is admitted only when Agent work begins.

The mode is published before extension startup and model admission. `/agents` can therefore attach a dialog or custom surface opened by `session_start`. Extension lifecycle behavior is not filtered or replayed: if `session_start` sends a user message or otherwise starts Agent work, that work activates the prepared Runtime normally.

## Per-Agent presentation

A child mode owns its transcript components, pending and working state, widgets, editor, footer, statuses, notifications, selectors, dialogs, extension commands, shortcuts, tools, and focused overlays. Extension UI calls always target that mode, whether or not it is selected. They do not mutate the Owner editor, footer, statuses, widgets, notifications, focus, or transcript, and they do not affect another Agent mode.

Opening an Agent view attaches the existing mode or prepares it once when absent. It does not rebind extensions, replay `session_start`, recreate the editor, or copy child UI state into the Owner TUI. Runtime identity therefore remains stable when a Dormant Agent starts work, when coordination Delivery activates it, and when a selected Run fails.

## Detached terminal

Each child mode renders against a detached terminal. The terminal proxies available dimensions and retains Pi's normal input and resize callbacks while discarding physical writes, title changes, progress updates, cursor operations, and screen-control output.

The full-window Owner overlay renders the child renderer's complete fullscreen frame. Input goes through the detached terminal callback rather than directly to the editor, preserving normal focus routing for custom editors, extension overlays, autocomplete, commands, shortcuts, mouse input, and transcript navigation.

The Owner's runtime, session, services, diagnostics, component tree, editor implementation and text, footer, extension context, and physical terminal remain mounted throughout attachment.

An embedded child mode is not a process owner. It installs no process signal handlers, never calls `process.exit()`, and cannot independently end the Workflow. `/quit`, Ctrl-D, and repeated Ctrl-C forward shutdown intent to the continuously bound Owner. Child render, editor-input, and input-acquisition failures close the exact view, restore Owner input routing, and report one Owner diagnostic.

Projection initialization is serialized because Pi themes, theme callbacks, registered themes, and keybindings are process-global. Incidental child initialization changes are restored before extension startup, while explicit child or Owner theme changes remain shared across the Workflow. Footer git-watcher startup is deferred until mode construction succeeds so a late constructor failure has no unreachable watcher.

## Runtime preparation and Run admission

Selecting a Dormant Agent resolves its current configuration and prepares the same full Runtime used for later work. Selection alone does not initialize Run-scoped Request relationships, append transcript evidence, or invoke the model. The Agent remains Dormant.

Extension actions retain their native semantics. UI-only commands leave the Agent Dormant. Editor submission, a slash command or `session_start` handler that emits model-starting input, and ordinary coordination Delivery activate an exact Run in the already-attached Runtime. Runtime and projection identity remain unchanged through activation.

Model execution remains behind projection readiness, coordination policy, and Workflow capacity admission. Run activation establishes the exact handle used for Delivery, Request retention, interruption, termination, failure, and Operational Incident evaluation.

When a selected Run releases or fails, its exact Run state ends while the Runtime can remain attached and Dormant. Later work activates a new exact Run in that Runtime. Closing a selected Dormant Runtime removes `interactive_selection` retention and disposes it; closing the view never invents Run work or an Operational Incident.

## Projection lifecycle

The projection adapter concentrates the private Pi seams needed to initialize one child mode, expose its laid-out fullscreen frame, update detached dimensions, dispatch terminal input, publish native render changes, and dispose the Runtime.

A Runtime projection is created once and remains stable across Dormant-to-live activation and selected Run failure. Unselected Dormant Runtime cleanup, initialization rollback, termination, and Workflow shutdown dispose its mode and session exactly once. A selected Run can end without disposing or replacing the retained Runtime.
