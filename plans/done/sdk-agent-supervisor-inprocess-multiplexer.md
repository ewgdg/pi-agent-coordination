# SDK Agent supervisor in-process multiplexer prototype

## Goal

Answer whether stock `pi`, started normally with an extension, can keep Owner and directly spawned SDK `AgentSession`s alive in one process while Pi's native `InteractiveMode` switches between them without disposing the deselected Agent.

## Intention

Replace transcript projection and editor interception with one selected-session seam. Pi remains responsible for transcript rendering, tool rendering, pending queues, working state, editor behavior, history, Vim integration, footer state, and extension UI.

## Scope and constraints

- Throwaway prototype on `prototype/sdk-agent-supervisor-inprocess-multiplexer`.
- Do not modify or fork Pi.
- Pin the installed Pi version and fail fast if the private runtime shape differs.
- Start through normal `pi`; no wrapper executable and no child shell or worker process.
- Owner and child sessions remain live until final application shutdown.
- Do not retain the process-isolated implementation as a supported mode.
- Preserve the existing process-isolated branch until this prototype receives real-terminal validation.
- Use behavior-first tests at the confirmed public seams before implementation.

## Confirmed test seams

1. `LiveSessionMultiplexer.select(agentKey)` is the lifecycle seam. Selection changes the runtime exposed to Pi, requests one native UI rebind, and does not dispose or abort either the previous or selected session.
2. The real `pi` terminal is the interaction seam. Selecting a child through `/agents` must expose that child's native transcript/editor/tool/queue behavior; switching away must not stop its active work; switching back must show the continued native state.
3. Final supervisor shutdown is the ownership seam. It disposes every retained session exactly once.
4. The Human Request bridge is the clarification seam. A child request creates
   Owner-only DECIDE attention, changes that child to `waiting (human)`, and
   consumes the next interactive submission in that child's native editor as
   the answer without starting a model turn.

## Work plan

1. Prove the startup hook can capture the Owner `AgentSessionRuntime` before `InteractiveMode` binds it.
2. Add the lifecycle test tracer: Owner to child to Owner without disposal.
3. Implement the minimum pinned private adapter and in-process child creation needed to pass it.
4. Add final-shutdown ownership behavior.
5. Add `/agents` selection using native Pi overlay components and direct-child activity only.
6. Run strict TypeScript and automated tests.
7. Exercise the real TUI with Owner and two children, including active switching, tool rendering, `Working...`, Enter, Alt+Enter, Alt+Up, editor history, and Vim behavior.
8. Record the observed verdict; do not publish or remove the older variant without explicit approval.
9. Restore the selected-child footer identity/phase styling and prove the
   Human Request path with behavior-first tests plus a real-terminal check.

## Validation

- Failing test observed before each implementation slice.
- Strict TypeScript passes.
- The normal `pi` command starts the prototype extension.
- Terminal-level evidence confirms native child behavior rather than projected lookalikes.
- Process inspection confirms no child worker process is created.

## Progress

- [x] Created isolated branch and worktree from `main`.
- [x] Verified Pi 0.82.1 replaces and disposes sessions in built-in switching.
- [x] Verified extension loading occurs before `AgentSessionRuntime` and `InteractiveMode` construction, allowing a pinned startup interception experiment.
- [x] Confirmed the lifecycle, real-terminal, and final-shutdown test seams.
- [x] Implemented retained in-process Owner, Researcher, and Builder sessions.
- [x] Kept native input collection available while a deselected Agent remains active.
- [x] Preserved native transcript, tool, working, steering, follow-up, queue recovery, history, and Vim behavior in the real terminal.
- [x] Prevented retained-session selection from replaying `session_start` while refreshing extension host bindings.
- [x] Made final shutdown emit `session_shutdown` with reason `quit` and dispose every retained session exactly once.
- [x] Added project-local auto-loading so the prototype starts with plain `pi`.
- [x] Completed final automated validation and clean-shutdown process inspection.
- [x] Kept the selected Agent's editor and footer on the terminal bottom after retained-session switches.
- [x] Replaced the unbounded `/agents` editor menu with a terminal-height-aware overlay using Pi's native `SelectList`.
- [x] Restored the selected-child identity/phase footer styling without replacing Pi's native footer.
- [x] Added the in-process Human Request bridge, Owner-only DECIDE attention, native transcript turns, and child-editor answer routing.
- [x] Added behavior tests and exercised the complete Human Request flow in a real 100x30 terminal.
- [x] Capped the menu at 80 columns and split Attention Inbox from the Agent roster into stacked sections with one native selection flow.
- [x] Added a fixed nested roster and breadcrumbed zoom navigator with fixed Owner access and child-only Agent scopes.
- [x] Added a fixed two-row expansion beneath the focused selector entry for identity, role, model/thinking, and queue details.
- [x] Made the first pending attention item the initial menu selection, falling back to the current Agent when the inbox is empty.
- [x] Finalized compact section spacing, label-aligned focus details, and `j`/`k` list navigation.
- [x] Received user acceptance of the real-terminal visual and interaction design.

## Surprises and discoveries

- `InteractiveMode.rebindCurrentSession()` reruns full session extension binding. Retained selection now refreshes host bindings without replaying startup or resource discovery.
- Native `InteractiveMode.run()` waits for one prompt to finish before requesting the next input. A selected idle session was therefore unusable while a deselected session streamed until the prototype changed input collection into a continuous dispatch gate.
- Extension binding combines host-context refresh, `session_start`, and resource discovery. Retained-session selection needs only the first operation; replaying the full bind duplicated startup side effects.
- Project-local auto-discovery also runs for SDK child services. Children must exclude the supervisor bootstrap extension while retaining normal extensions and their injected child-specific supervisor extension.
- Pi's differential renderer can retain the previous session's viewport origin when the selected transcript becomes shorter. A session-identity change must force one full native redraw after rebinding.
- Pi's extension `select()` renders every option by replacing the editor. A bounded custom overlay can reuse the public `SelectList`, preserve native keys, and avoid changing the base viewport height.
- Pi's pinned private session event seam can append ordinary assistant/user turns directly. This preserves native transcript components and spacing without a custom renderer or transcript projection.

## Decisions

- Process isolation is intentionally excluded because it prevents direct native UI binding and is not valuable enough for this local trusted-Agent use case.
- The old IPC transcript projection is a comparison artifact, not an alternative production mode.
- Each Agent receives its native extension startup once. Later selection refreshes the private extension host bindings and explicitly remounts supervisor-owned UI.
- A session switch rebuilds the selected Agent's native terminal frame and scrollback; initial startup and same-session rebinds remain differential.
- `/agents` is a fully framed centered overlay whose visible roster rows follow terminal height and cap at ten; long rosters scroll with Pi's native position indicator.
- `/agents` keeps one native `SelectList` for continuous navigation, presents Attention Inbox, Owner, and the scoped Agent roster as adjacent stacked sections, and caps the centered frame at 80 columns. The roster is a zoom navigator: each scope contains only direct children, Up/Down or `k`/`j` moves focus, Right Arrow/`l` opens a highlighted Agent's scope, Left Arrow/`h` returns to its parent, and Enter always switches. Breadcrumbs omit Owner, keep at most the newest three Agent scopes, and discard additional old scopes as width tightens.
- The cursor-focused selector entry receives exactly two label-aligned inline detail rows. The overlay always budgets those rows, so cursor movement changes content without changing geometry.
- `/agents` initially selects the first attention item when present; with a quiet inbox it initially selects the current Agent.
- The worktree uses Pi's project-local extension discovery so the launch command remains `pi`.
- Human Requests create Owner-only DECIDE attention. Only the requesting child's next interactive editor submission is consumed as the answer; other child input remains native Pi input.
- The supervisor status segment stays dim except for warning-colored `waiting (human)`; Pi's model/thinking footer remains untouched.

## Outcomes and retrospective

The in-process design is viable as a hands-on prototype. All 21 behavior tests
and strict TypeScript pass. Real-terminal validation confirmed native transcript,
tool, editor, queue, Vim, working-indicator, retained-selection, bottom-aligned
viewport, and clean-shutdown behavior without a child worker process. The project extension bootstrap must be
excluded from child resource discovery; otherwise SDK-created children recursively
load the Owner supervisor and collide on `/agents`.

A real-terminal Human Request check confirmed Owner-only DECIDE attention,
selective warning color on the child footer phase, ordinary native request/answer turns with
normal spacing, attention settlement, and return to idle.

The user accepted the real-terminal visual and interaction design. The prototype
answers its design question and is ready to remain captured on its dedicated branch.
