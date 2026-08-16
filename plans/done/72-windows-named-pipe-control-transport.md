# Windows named-pipe Control transport

## Goal

Add a native Windows named-pipe Adapter behind the existing platform-neutral Control Transport seam so process-isolated Agent Runtimes can authenticate and communicate on `win32` without changing Control Channel or coordination behavior.

## Intention

Keep platform behavior local to `src/control`: Unix uses filesystem sockets, Windows uses short random names in the `\\.\pipe\` namespace, and callers continue to use only `ControlEndpoint`, `ControlTransport`, and `ControlTransportListener`.

## Scope & Constraints

- Extend the closed endpoint schema with `transport: "named-pipe"`.
- Preserve ordered bytes, serialized/backpressured writes, early-data buffering, close notification, abortable acceptance, and idempotent cleanup.
- Preserve framing, one-shot Hello token admission, request IDs, cancellation, lifecycle, and coordination callers unchanged.
- Allocate pipe names independently of filesystem paths; keep child bootstrap/context artifacts in a separate private temporary directory.
- Add Windows/macOS CI that is triggered only by related paths.
- Do not add TCP, reconnect/replay, a user setting, or authentication bypass.
- Do not expand into general Windows process-tree ownership unless named-pipe test cleanup strictly requires it.

## Confirmed test seams

The issue acceptance criteria define these public seams:

1. Closed `ControlEndpoint` and child bootstrap validation.
2. Platform selection and endpoint-kind routing through `admitControlTransportPlatform`, `createPlatformControlListener`, and `connectControlTransport`.
3. `ControlTransportListener` / `ControlTransport` observable behavior over a real Windows named pipe.
4. Unchanged `FramedAgentControlChannel` and `AgentControlAdmissionBroker` behavior over that Adapter.
5. Process-runtime artifact allocation and cleanup without inspecting endpoint addresses.
6. Path-filtered Windows/macOS workflow execution.

## Work Plan

1. Add failing schema/platform/address tests for the named-pipe endpoint and `win32` admission.
2. Extract Node IPC socket mechanics shared by Unix sockets and named pipes while preserving the existing Control Transport interface and Unix tests.
3. Implement bounded named-pipe allocation, validation, listener/connect factories, collision handling, and cleanup.
4. Route platform listener/connect operations by both OS and endpoint kind; reject mismatches before touching `node:net`.
5. Add Windows-only contract, admission, cancellation, collision, peer-exit, pending-write, and cleanup integration tests.
6. Allocate child bootstrap/context artifacts in a private filesystem directory independent of the listener endpoint; clean it on every terminal path.
7. Add path-filtered Windows/macOS CI and validate targeted local suites, typechecking, and diff hygiene.

## Validation

- `npm run test:fast -- --file=control-protocol-schemas.test.ts`
- `npm run test:process -- --file=unix-control-transport.test.ts`
- `npm run test:process -- --file=named-pipe-control-transport.test.ts` (runs on Windows; skipped elsewhere)
- targeted process-runtime artifact tests where locally applicable
- `npm run typecheck`
- `git diff --check`
- verify only Control Adapter modules import `node:net` and non-Control production modules do not inspect pipe addresses

## Progress

- [x] Read issue #72, current Control transport implementation, process-runtime artifact flow, test runner, and Node/Win32 primary documentation.
- [x] Confirmed test seams from the issue acceptance criteria.
- [x] Endpoint schema and platform selection are red/green.
- [x] Shared Node IPC mechanics and named-pipe Adapter are implemented.
- [x] Windows contract and failure-path tests are added.
- [x] Process artifact paths are independent of endpoint addresses.
- [x] Path-filtered Windows/macOS CI is added.
- [x] Targeted validation passes; the full fast suite retains one unrelated rendering failure in `tests/message-tool.test.ts`.

## Surprises & Discoveries

- The process Runtime currently derives `bootstrap.json` and `context.md` paths with `dirname(listener.endpoint.address)`. A Windows pipe address is not a filesystem path, so this must be separated for real child startup.
- The repository currently has no GitHub Actions workflows.
- Existing full Pi process tests are skipped on Windows and include POSIX process-group assumptions. General Windows process-tree termination remains separate from this IPC Adapter.
- Node documents `readableAll` and `writableAll` as false by default for IPC listeners; the named-pipe listener keeps those owner-scoped defaults explicit.
- Windows synthesizes POSIX file mode bits, so the child cannot use the Unix `mode & 0o077` bootstrap check there. Windows instead relies on the unique current-user temporary artifact directory; Unix retains the exact owner-only check.
- libuv can wait up to 30 seconds for a busy Windows pipe. The shared connector now aborts local IPC connection attempts after five seconds so startup cancellation does not leave a hidden connect operation alive.

## Decisions

- Reuse one internal Node IPC socket implementation for both Unix and named-pipe Adapters rather than duplicate ordering, buffering, backpressure, and close logic.
- Restrict accepted named-pipe addresses to generated flat ASCII names under exactly `\\.\pipe\`; there is no user-configured endpoint surface.
- Keep runtime artifacts in their own random directory under the configured runtime root or OS temporary directory. Never derive a filesystem location from a Control endpoint.
- Keep Windows-specific transport integration focused on the real named-pipe seam; do not unskip POSIX process-group tests as part of this issue.
- On Windows, terminate the exact ConPTY through node-pty's signal-less `kill()` interface. General Windows descendant-tree ownership remains separate.

## Outcomes & Retrospective

The closed endpoint union now admits native Windows named pipes, while platform routing rejects endpoint/OS mismatches before touching `node:net`. Unix sockets and named pipes share one ordered, buffered, backpressured Node IPC implementation, so Control framing and authenticated admission remain unchanged.

The process Runtime no longer interprets endpoints as filesystem paths. Bootstrap and Project Context artifacts live in a separate unique directory and all terminal cleanup paths continue through later cleanup actions even if one artifact operation fails.

Windows-only tests cover the Control Channel contract, one-shot Hello admission, malformed descriptors, cancellation, collisions, peer exit, pending writes, rebinding after cleanup, real Pi child startup, graceful shutdown, and unexpected-exit artifact cleanup. A path-filtered GitHub Actions matrix runs those tests on Windows and the Unix Adapter on macOS.
