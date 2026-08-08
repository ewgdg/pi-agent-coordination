# Child UI context

Every child session binds extensions with its own detached UI context instead of
the Owner's TUI context. A child's `session_start` side effects — notifications,
editor registration, status, and widget writes — are stored per-child and never
reach the Owner's transcript, editor slot, footer, or widgets.

## Per-child state

`createDetachedExtensionUIContext` builds an `ExtensionUIContext` whose four
stateful members write into per-child storage (`DetachedChildUIState`, kept in a
WeakMap keyed by the child session):

- `notify` → `notifications`
- `setEditorComponent` / `getEditorComponent` → `editorComponent`
- `setStatus` → `statuses`
- `setWidget` → `widgets`

All remaining members settle inert (prompts resolve as dismissed) so child
extensions neither touch the Owner's presentation nor hang on unanswerable
prompts. Read-only theme access is delegated to the Owner's TUI context captured
at binding time. `readDetachedChildUIState(session)` exposes the state so a
child's own view can later instantiate its editor and replay its notifications.

## Context switching on selection

A child's extension context follows the selected presentation:

- **Created** with the detached context; `session_start` runs against it.
- **Selected** in the interactive host: Pi's native rebind replaces the context
  with a fresh TUI-bound one (binding-only refresh, no `session_start` replay).
  The captured per-child editor factory is restored into the TUI from
  `NativeExtensionUIState`, so the child's own registration — never the
  Owner's — is presented.
- **Deselected**: `reinstallDetachedExtensionUIContext` swaps the session back
  to its detached context, so later extension UI calls stay per-child instead of
  reaching the newly selected Agent's presentation. The captured snapshot is
  refreshed from the detached state for the next selection.
- **Degraded** (native rebind failed while the presentation stays selected):
  `attachNativeExtensionUIContext` falls back to the Owner's TUI context — the
  session IS the presented one, so its surfaces must keep working, and the
  detached context would leave them inert.

Owner behavior is unchanged: the Owner's session keeps its native TUI context
throughout, and the editor-preservation seam (`capture`/`restore`) is the same
for every session.

## Pi-native Run projections

Every exact live non-Owner Run also owns a real Pi `InteractiveMode` projection.
It is constructed after that Run binds extensions and before coordination admits
model-visible work. The projection subscribes for the Run's complete subsequent
event sequence and exposes only two native components: transcript presentation
and Run-status presentation. Its detached terminal cannot write progress, title,
input, or frames into the Owner terminal.

Projection ownership follows the exact Run rather than Interactive Selection.
Clean release, failure, termination, startup rollback, and Workflow shutdown
dispose the projection before disposing its session. Closing or opening a
presentation surface is therefore not part of live projection ownership.

Dormant inspection uses the same component seam over a separate passive session
opened on the Agent's durable `SessionManager`. The passive session has no active
tools and the seam exposes no editor or input method; releasing it disposes both
the Dormant projection and that passive session without starting a successor Run
or appending transcript evidence.
