# Child UI context

Every exact live ordinary Agent or Moderator Run owns one complete Pi `InteractiveMode`. The mode is constructed and published before extension binding and model admission, so the child session's extensions bind to that mode's own UI context and emit `session_start` exactly once. Publishing the initializing mode lets `/agents` display and operate a dialog opened by `session_start`; model work remains gated until that startup UI settles.

## Per-child presentation

A child mode owns its own transcript components, pending and working state, widgets, editor, footer, statuses, notifications, selectors, dialogs, extension commands, shortcuts, and focused overlays. Extension UI calls always target that child mode, whether or not it is currently selected. They do not mutate the Owner editor, footer, statuses, widgets, notifications, focus, or transcript, and they do not affect another child mode.

Opening an Agent view attaches the existing mode. It does not rebind extensions, replay `session_start`, recreate the editor, or copy child UI state into the Owner TUI. Repeated view cycles therefore preserve the exact mode's editor and extension presentation until its Run ends.

## Detached terminal

Each child mode renders against a detached terminal. The terminal proxies the available dimensions, retains Pi's normal input and resize callbacks, and discards physical writes, title changes, progress updates, cursor operations, and screen-control output.

The full-window Owner overlay renders the child renderer's complete fullscreen frame. Input is forwarded through the detached terminal callback, not sent directly to the editor. Pi therefore retains normal focus routing for custom editors, extension overlays, autocomplete, commands, shortcuts, mouse input, and transcript navigation.

The Owner's original runtime, session, services, diagnostics, component tree, editor implementation and text, footer, extension context, and physical terminal remain mounted throughout attachment.

An embedded child mode is a component, not a process owner. It installs no process signal handlers, never calls `process.exit()`, and cannot independently dispose its runtime. `/quit`, Ctrl-D, and repeated Ctrl-C forward shutdown intent to the continuously bound Owner, which performs Pi's normal graceful process shutdown. Child render, editor-input, and input-acquisition failures close the exact view, restore Owner input routing, and report one Owner diagnostic. Projection initialization is serialized because Pi themes, theme callbacks, registered themes, and keybindings are process-global. Incidental child constructor/settings application is restored before extension startup, while explicit child or Owner theme changes remain shared across the Workflow. Footer git-watcher startup is deferred until mode construction succeeds so a late constructor failure has no unreachable watcher to clean up.

## Pi-native Run projection

The projection adapter concentrates the private Pi seams needed to:

- initialize one complete child `InteractiveMode`;
- expose its already-laid-out fullscreen frame;
- update detached terminal dimensions;
- dispatch terminal input;
- notify the attached Owner overlay about native render requests; and
- dispose the exact mode with its session.

Model work remains behind the Run-admission gate until mode initialization, extension startup, transcript subscription, and coordination runtime policy are complete. This ensures the mode observes the Run's first model-visible event without permitting Pi startup behavior to restore generic retries or mutate the Owner presentation.

Projection ownership follows the exact Run, not view attachment. Clean release, failure, termination, startup rollback, and Workflow shutdown emit `session_shutdown`, release extension-owned UI, and dispose the live mode with its session exactly once. Closing or switching a view only removes `interactive_selection`; it never directly disposes a live projection retained by the Run.

## Dormant activation and failure presentation

Selecting a Dormant Agent starts exactly one successor Run in the Agent lane with `interactive_selection` retention. Selection itself submits no model input. The successor's complete live mode supplies normal coordination tools, commands, shell input, custom extensions, editor, and footer immediately after startup, while its initializing projection remains available for `session_start` UI before readiness settles.

Concurrent selection and Message Delivery converge on the same exact startup attempt. Selection records the observed Run sequence, so queued or switching handoff work cannot reinterpret a failed attempt as permission to start another successor. Closing a selected mode with pending startup UI cancels that exact initialization before lane-owned cleanup; selectors, inputs, editors, and custom extension surfaces settle without hidden terminal input. The close then removes `interactive_selection`, and ordinary Run release decides whether the Agent becomes Dormant again.

If a selected live Run fails, the durable view first receives a view-owned Dormant failure presentation before the failed exact-Run projection is disposed. Explicit human input or ordinary Message Delivery can start a successor, and the same durable attachment receives its complete live mode before model-visible work proceeds. Failure-presentation and live child settings remain isolated from the Owner settings manager.
