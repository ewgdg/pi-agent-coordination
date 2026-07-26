#!/usr/bin/env python3
"""PROTOTYPE — control a normal interactive Pi Agent Run without editor injection.

A Pi extension owns an authenticated local socket and invokes Pi's public APIs
inside the same interactive TUI process. Human input remains in the Pi panel;
machine submit, redirect, abort, Human Request, and shutdown never touch its editor.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import shlex
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

SCRIPT_PATH = Path(__file__).resolve()
EXTENSION_PATH = SCRIPT_PATH.with_name("agent-run-extension.ts")
PROTOCOL_VERSION = 1
MAX_RESPONSE_BYTES = 64 * 1024
LEASE_CONFLICT_EXIT = os.EX_CANTCREAT
BOLD = "\033[1m"
DIM = "\033[2m"
RESET = "\033[0m"


def canonical_session_id(value: str) -> str:
    return str(uuid.UUID(value))


def run_json(command: list[str], *, check: bool = True) -> dict[str, Any]:
    completed = subprocess.run(command, text=True, capture_output=True)
    if check and completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise RuntimeError(f"{' '.join(command)} failed: {detail}")
    output = completed.stdout.strip() or completed.stderr.strip()
    if not output:
        return {"returncode": completed.returncode}
    try:
        parsed = json.loads(output)
    except json.JSONDecodeError:
        return {"returncode": completed.returncode, "output": output}
    if isinstance(parsed, dict):
        parsed.setdefault("returncode", completed.returncode)
        return parsed
    return {"returncode": completed.returncode, "result": parsed}


def walk(value: Any):
    yield value
    if isinstance(value, dict):
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def find_first(value: Any, keys: set[str]) -> Any:
    for candidate in walk(value):
        if not isinstance(candidate, dict):
            continue
        for key in keys:
            if key in candidate:
                return candidate[key]
    return None


def find_session_path(value: Any) -> str | None:
    direct = find_first(value, {"agent_session_path", "session_path"})
    if isinstance(direct, str):
        return direct
    for candidate in walk(value):
        if not isinstance(candidate, dict):
            continue
        session = candidate.get("agent_session")
        if isinstance(session, dict) and session.get("kind") == "path" and isinstance(session.get("value"), str):
            return session["value"]
    return None


def validate_owned_directory(path: Path, *, require_private: bool) -> None:
    metadata = path.lstat()
    permissions = stat.S_IMODE(metadata.st_mode)
    if path.is_symlink() or not stat.S_ISDIR(metadata.st_mode):
        raise RuntimeError(f"prototype runtime path is not a real directory: {path}")
    if metadata.st_uid != os.getuid():
        raise RuntimeError(f"prototype runtime path is owned by another user: {path}")
    if permissions & 0o022:
        raise RuntimeError(f"prototype runtime path is writable by another user: {path}")
    if require_private and permissions != 0o700:
        raise RuntimeError(f"prototype private directory must have mode 0700: {path}")


def ensure_private_directory(path: Path) -> None:
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass
    validate_owned_directory(path, require_private=True)


def lease_path_for(session_id: str) -> Path:
    configured_runtime = os.environ.get("XDG_RUNTIME_DIR")
    if configured_runtime:
        runtime_base = Path(configured_runtime)
    else:
        runtime_base = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
        runtime_base.mkdir(mode=0o700, parents=True, exist_ok=True)
    validate_owned_directory(runtime_base, require_private=False)
    prototype_root = runtime_base / "herdr-agent-run-prototype"
    ensure_private_directory(prototype_root)
    lease_directory = prototype_root / "leases"
    ensure_private_directory(lease_directory)
    return lease_directory / f"{session_id}.json"


def acquire_lease(lease_path: Path, record: dict[str, Any]) -> None:
    descriptor = os.open(lease_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as lease_file:
        json.dump(record, lease_file)
        lease_file.flush()
        os.fsync(lease_file.fileno())


def parse_pane_id(response: dict[str, Any]) -> str:
    pane_id = find_first(response, {"pane_id"})
    if not isinstance(pane_id, str):
        raise RuntimeError(f"Herdr split did not return a pane ID: {response}")
    return pane_id


@dataclass
class Snapshot:
    process: str
    work: str
    attention: str
    herdr_status: str
    session_path: str | None
    pi_pid: int | None


class Prototype:
    def __init__(self, forwarded_environment: dict[str, str], *, session_id: str | None = None) -> None:
        self.scratch = Path(tempfile.mkdtemp(prefix="har-prototype."))
        self.scratch.chmod(0o700)
        self.session_directory = self.scratch / "sessions"
        self.session_directory.mkdir()
        self.session_id = canonical_session_id(session_id) if session_id else str(uuid.uuid4())
        self.agent_name = f"agent-run-proof-{self.session_id[:8]}"
        self.run_token = str(uuid.uuid4())
        self.lease_path = lease_path_for(self.session_id)
        self.control_socket_path = self.scratch / "c.sock"
        self.control_token = secrets.token_hex(32)
        self.forwarded_environment = forwarded_environment
        self.pane_id: str | None = None
        self.admitted_pid: int | None = None
        self.runtime_id: str | None = None
        self.last_control_receipt = "none"
        self.last_proof = "Not launched"
        self.shutdown_requested = False
        if len(os.fsencode(self.control_socket_path)) >= 90:
            raise RuntimeError("prototype control socket path is too long")

    def control_request(
        self,
        operation: str,
        *,
        text: str | None = None,
        token: str | None = None,
        timeout: float = 3,
    ) -> dict[str, Any]:
        request_id = str(uuid.uuid4())
        request: dict[str, Any] = {
            "version": PROTOCOL_VERSION,
            "id": request_id,
            "token": token or self.control_token,
            "op": operation,
        }
        if text is not None:
            request["text"] = text
        payload = (json.dumps(request, separators=(",", ":")) + "\n").encode()
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(timeout)
            client.connect(str(self.control_socket_path))
            client.sendall(payload)
            client.shutdown(socket.SHUT_WR)
            response_buffer = bytearray()
            while b"\n" not in response_buffer:
                chunk = client.recv(4096)
                if not chunk:
                    break
                response_buffer.extend(chunk)
                if len(response_buffer) > MAX_RESPONSE_BYTES:
                    raise RuntimeError("control response exceeds 64 KiB")
        response_line, separator, trailing = bytes(response_buffer).partition(b"\n")
        if not separator or trailing.strip():
            raise RuntimeError("control response must contain exactly one NDJSON object")
        response = json.loads(response_line)
        if response.get("version") != PROTOCOL_VERSION or response.get("id") != request_id:
            raise RuntimeError(f"uncorrelated control response: {response}")
        self.last_control_receipt = f"{operation}: {response.get('phase')}"
        return response

    def require_control(self, operation: str, *, text: str | None = None) -> dict[str, Any]:
        response = self.control_request(operation, text=text)
        if response.get("ok") is not True:
            error = response.get("error", {})
            raise RuntimeError(f"{operation} rejected: {error.get('code')}: {error.get('message')}")
        return response

    def wait_for_probe(self, timeout: float = 15) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        last_error: Exception | None = None
        while time.monotonic() < deadline:
            try:
                response = self.require_control("probe")
                if response.get("sessionFile"):
                    return response
            except (ConnectionError, FileNotFoundError, OSError, TimeoutError, RuntimeError) as error:
                last_error = error
            time.sleep(0.1)
        raise TimeoutError(f"interactive Pi control socket did not become ready: {last_error}")

    def launch(self) -> None:
        acquire_lease(
            self.lease_path,
            {
                "sessionId": self.session_id,
                "sessionDirectory": str(self.session_directory),
                "runToken": self.run_token,
                "state": "admitting",
            },
        )
        split_command = [
            "herdr",
            "pane",
            "split",
            "--current",
            "--direction",
            "down",
            "--ratio",
            "0.35",
            "--cwd",
            str(Path.cwd()),
            "--no-focus",
        ]
        for name, value in self.forwarded_environment.items():
            split_command.extend(["--env", f"{name}={value}"])
        self.pane_id = parse_pane_id(run_json(split_command))
        try:
            self.start_agent_when_shell_ready()
            probe = self.wait_for_probe()
            herdr_session_path = self.wait_for_session_path()
            state = self.snapshot()
            self.validate_binding(probe, herdr_session_path, state.pi_pid, require_idle=True)
            self.admitted_pid = int(probe["pid"])
            self.runtime_id = str(probe["runtimeId"])
            record = json.loads(self.lease_path.read_text())
            record.update(
                {
                    "state": "ready",
                    "paneId": self.pane_id,
                    "sessionFile": probe["sessionFile"],
                    "pid": self.admitted_pid,
                    "runtimeId": self.runtime_id,
                }
            )
            self.lease_path.write_text(json.dumps(record))
            self.last_proof = "PASS — authenticated control bound the intended interactive Pi Run"
        except Exception:
            self.close_pane()
            raise

    def start_agent_when_shell_ready(self) -> None:
        assert self.pane_id is not None
        pi_executable = shutil.which("pi")
        if not pi_executable:
            raise RuntimeError("Pi executable disappeared after dependency validation")
        pi_command = [
            pi_executable,
            "--session-dir",
            str(self.session_directory),
            "--session-id",
            self.session_id,
            "--extension",
            str(EXTENSION_PATH),
            f"--prototype-control-socket={self.control_socket_path}",
            f"--prototype-control-token={self.control_token}",
            "--no-skills",
            "--no-prompt-templates",
        ]
        launch_script = self.scratch / "launch-pi.sh"
        # The private Bash script and absolute executable bypass interactive zsh pi() wrappers.
        launch_script.write_text(f"#!/bin/bash\nexec {shlex.join(pi_command)}\n")
        launch_script.chmod(0o700)
        run_json(["herdr", "pane", "send-text", self.pane_id, f"/bin/bash {shlex.quote(str(launch_script))}"])
        run_json(["herdr", "pane", "send-keys", self.pane_id, "enter"])

        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            detected = run_json(["herdr", "agent", "get", self.pane_id], check=False)
            if find_first(detected, {"agent_status"}) in {"idle", "working", "blocked", "done"}:
                run_json(["herdr", "agent", "rename", self.pane_id, self.agent_name])
                return
            time.sleep(0.1)
        pane_output = run_json(
            ["herdr", "pane", "read", self.pane_id, "--source", "visible", "--format", "text"],
            check=False,
        )
        raise RuntimeError(f"Herdr did not detect an interactive Pi launched by {launch_script.name}: {pane_output}")

    def validate_binding(
        self,
        probe: dict[str, Any],
        herdr_session_path: str | None,
        herdr_pid: int | None,
        *,
        require_idle: bool = False,
    ) -> None:
        probe_file = probe.get("sessionFile")
        if probe.get("sessionId") != self.session_id or not self.binding_matches(probe_file):
            raise RuntimeError(f"control probe reported the wrong session: {probe}")
        if herdr_session_path != probe_file:
            raise RuntimeError(f"Herdr and Pi disagree on session binding: {herdr_session_path} != {probe_file}")
        if herdr_pid is None or probe.get("pid") != herdr_pid:
            raise RuntimeError(f"Herdr and control socket disagree on Pi PID: {herdr_pid} != {probe.get('pid')}")
        if require_idle and probe.get("idle") is not True:
            raise RuntimeError("Pi was not idle at admission")

    def refresh_control_binding(self) -> dict[str, Any]:
        probe = self.require_control("probe")
        state = self.snapshot()
        self.validate_binding(probe, state.session_path, state.pi_pid)
        if self.admitted_pid is not None and probe.get("pid") != self.admitted_pid:
            raise RuntimeError("interactive Pi process changed after admission")
        observed_runtime = str(probe.get("runtimeId"))
        if self.runtime_id and observed_runtime != self.runtime_id:
            self.runtime_id = observed_runtime
            self.last_proof = "Pi extension reloaded; authenticated control rebound to the same Run"
        return probe

    def agent_info(self) -> dict[str, Any]:
        return run_json(["herdr", "agent", "get", self.agent_name], check=False)

    def process_info(self) -> dict[str, Any]:
        if not self.pane_id:
            return {}
        return run_json(["herdr", "pane", "process-info", "--pane", self.pane_id], check=False)

    def wait_for_session_path(self, timeout: float = 10) -> str | None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            session_path = find_session_path(self.agent_info())
            if session_path:
                return session_path
            time.sleep(0.1)
        return None

    def binding_matches(self, session_path: Any) -> bool:
        if not isinstance(session_path, str):
            return False
        actual = Path(session_path).resolve()
        return actual.parent == self.session_directory.resolve() and self.session_id in actual.name

    def snapshot(self) -> Snapshot:
        agent = self.agent_info()
        process = self.process_info()
        status_value = find_first(agent, {"agent_status", "status", "state"})
        herdr_status = str(status_value) if status_value in {"idle", "working", "blocked", "done", "unknown"} else "unknown"
        foreground = find_first(process, {"foreground_processes"})
        pi_pid: int | None = None
        if isinstance(foreground, list):
            for entry in foreground:
                if not isinstance(entry, dict):
                    continue
                argv = entry.get("argv")
                name = str(entry.get("name", ""))
                executable = str(argv[0]) if isinstance(argv, list) and argv else ""
                if name == "pi" or Path(executable).name == "pi":
                    pid = entry.get("pid")
                    pi_pid = pid if isinstance(pid, int) else None
                    break
        process_state = f"present (PID {pi_pid})" if pi_pid is not None else "absent or unknown"
        if herdr_status == "working":
            work = "active"
        elif herdr_status in {"idle", "done"}:
            work = "settled"
        elif herdr_status == "blocked":
            work = "unknown while attention is projected"
        else:
            work = "unknown"
        attention = (
            "input-required"
            if herdr_status == "blocked"
            else "none"
            if herdr_status in {"idle", "working", "done"}
            else "unknown"
        )
        return Snapshot(process_state, work, attention, herdr_status, find_session_path(agent), pi_pid)

    def attempt_second_writer(self) -> None:
        completed = subprocess.run(
            [
                sys.executable,
                str(SCRIPT_PATH),
                "--session-id",
                self.session_id,
                "--admission-only",
            ],
            text=True,
            capture_output=True,
        )
        self.last_proof = (
            "PASS — second executable admission rejected before Pi spawn"
            if completed.returncode == LEASE_CONFLICT_EXIT
            else f"FAIL — second executable admission returned {completed.returncode}: "
            f"{completed.stderr.strip() or completed.stdout.strip()}"
        )

    def wait_for_status(self, desired: set[str], timeout: float = 30) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.snapshot().herdr_status in desired:
                return True
            time.sleep(0.2)
        return False

    def wait_for_control_idle(self, timeout: float = 30) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                probe = self.refresh_control_binding()
                if probe.get("idle") is True and self.snapshot().herdr_status in {"idle", "done"}:
                    return True
            except (ConnectionError, FileNotFoundError, OSError, RuntimeError):
                pass
            time.sleep(0.2)
        return False

    def request_human_input(self) -> None:
        self.refresh_control_binding()
        response = self.require_control("request_human")
        blocked = self.wait_for_status({"blocked"}, timeout=10)
        self.last_proof = (
            "PASS — socket opened a Human Request in the normal Pi panel"
            if blocked
            else f"Human Request did not reach blocked state: {response}"
        )

    def start_work(self) -> None:
        self.refresh_control_binding()
        response = self.require_control("submit", text="Use the bash tool to run `sleep 60`. Do not do anything else.")
        working = self.wait_for_status({"working"}, timeout=15)
        self.last_proof = "PASS — socket submission started normal Pi work" if working else f"Work did not become active: {response}"

    def interrupt_active_work(self) -> dict[str, Any]:
        self.refresh_control_binding()
        response = self.require_control("abort")
        settled = self.wait_for_control_idle(timeout=30)
        process_present = self.snapshot().pi_pid == self.admitted_pid
        if not settled or not process_present:
            raise RuntimeError(
                f"abort boundary not observed: settled={settled}, "
                f"processPresent={process_present}, response={response}"
            )
        return response

    def redirect(self) -> None:
        self.interrupt_active_work()
        response = self.require_control(
            "submit",
            text="The previous approach was interrupted. Wait for further instructions without running tools.",
        )
        self.last_proof = (
            "PASS — semantic redirect used abort, confirmed settlement, then submitted new guidance"
            if response.get("ok") is True
            else f"Semantic redirect submission failed: {response}"
        )

    def abort(self) -> None:
        self.interrupt_active_work()
        self.last_proof = "PASS — socket abort settled work without injecting editor text; Pi remains alive"

    def request_shutdown(self) -> None:
        if self.shutdown_requested:
            return
        self.refresh_control_binding()
        response = self.require_control("shutdown")
        self.shutdown_requested = True
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and self.snapshot().pi_pid is not None:
            time.sleep(0.2)
        pi_absent = self.snapshot().pi_pid is None
        self.last_proof = (
            "Socket requested Pi graceful shutdown; Pi is no longer observed, exact exit remains unproven"
            if pi_absent
            else f"Pi shutdown was accepted but Pi remains observed: {response}"
        )

    def render(self) -> None:
        state = self.snapshot()
        os.system("clear")
        print(f"{BOLD}PROTOTYPE — normal Pi TUI with authenticated control{RESET}\n")
        print(f"{BOLD}process presence{RESET}: {state.process}")
        print(f"{BOLD}work{RESET}:             {state.work}")
        print(f"{BOLD}attention{RESET}:        {state.attention}")
        print(f"{BOLD}Herdr status{RESET}:      {state.herdr_status}")
        print(f"{BOLD}lease{RESET}:             {'held' if self.lease_path.exists() else 'missing'}")
        print(f"{BOLD}session expected{RESET}:  {self.session_id}")
        print(f"{BOLD}session observed{RESET}:  {state.session_path or 'unknown'}")
        print(f"{BOLD}runtime{RESET}:           {self.runtime_id or 'unknown'}")
        print(f"{BOLD}control receipt{RESET}:   {self.last_control_receipt}")
        print(f"{BOLD}pane{RESET}:              {self.pane_id}")
        print(f"{BOLD}last proof{RESET}:        {self.last_proof}\n")
        print(f"{BOLD}[a]{RESET} reject second writer       {BOLD}[b]{RESET} verify session binding")
        print(f"{BOLD}[i]{RESET} open Human Request         {BOLD}[p]{RESET} refresh observations")
        print(f"{BOLD}[w]{RESET} socket-submit long work    {BOLD}[s]{RESET} abort-settle-submit redirect")
        print(f"{BOLD}[x]{RESET} socket semantic abort      {BOLD}[k]{RESET} socket graceful shutdown")
        print(f"{BOLD}[q]{RESET} explicit prototype cleanup")
        print(f"\n{DIM}Human input stays in Pi's panel. Machine controls never type into its editor.{RESET}")

    def close_pane(self) -> None:
        if self.pane_id:
            run_json(["herdr", "pane", "close", self.pane_id], check=False)
            self.pane_id = None

    def cleanup(self) -> None:
        if self.pane_id and self.snapshot().pi_pid is not None:
            try:
                probe = self.control_request("probe")
                if probe.get("ok") and probe.get("idle") is False:
                    self.control_request("abort")
                    self.wait_for_control_idle(timeout=10)
                self.control_request("shutdown")
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline and self.snapshot().pi_pid is not None:
                    time.sleep(0.2)
            except (ConnectionError, FileNotFoundError, OSError, RuntimeError):
                pass
        self.close_pane()
        if self.lease_path.exists():
            subprocess.run(["trash-put", str(self.lease_path)], check=False)
        if self.scratch.exists():
            subprocess.run(["trash-put", str(self.scratch)], check=False)

    def run(self) -> None:
        explicit_cleanup = False
        try:
            self.launch()
            while True:
                self.render()
                try:
                    action = input("\nAction: ").strip().lower()
                except EOFError:
                    self.last_proof = "No interactive stdin; run this command in a normal terminal"
                    return
                try:
                    if action == "a":
                        self.attempt_second_writer()
                    elif action == "b":
                        probe = self.refresh_control_binding()
                        self.last_proof = f"PASS — socket, Herdr, and lease bind the same Pi Run: {probe['pid']}"
                    elif action == "i":
                        self.request_human_input()
                    elif action == "p":
                        self.refresh_control_binding()
                        self.last_proof = "Observations and authenticated binding refreshed"
                    elif action == "w":
                        self.start_work()
                    elif action == "s":
                        self.redirect()
                    elif action == "x":
                        self.abort()
                    elif action == "k":
                        self.request_shutdown()
                    elif action == "q":
                        explicit_cleanup = True
                        return
                except (ConnectionError, FileNotFoundError, OSError, RuntimeError, TimeoutError) as error:
                    self.last_proof = f"CONTROL FAILURE — {error}"
        finally:
            if explicit_cleanup:
                self.cleanup()
            else:
                print(
                    f"\nFail-closed state retained. After independently confirming process teardown, "
                    f"soft-delete {self.lease_path} and {self.scratch} explicitly.",
                    file=sys.stderr,
                )


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Drive the interactive Pi Agent Run prototype")
    parser.add_argument(
        "--forward-env",
        action="append",
        default=[],
        metavar="NAME",
        help="Forward one exported environment variable into the Herdr pane; repeat as needed",
    )
    parser.add_argument(
        "--session-id",
        type=canonical_session_id,
        help="Use a specific session identity so cooperating executable launches contend on one lease",
    )
    parser.add_argument("--admission-only", action="store_true", help=argparse.SUPPRESS)
    return parser.parse_args()


def main() -> None:
    arguments = parse_arguments()
    missing_commands = [command for command in ("herdr", "pi", "trash-put") if not shutil.which(command)]
    if missing_commands:
        raise SystemExit(f"missing required commands: {', '.join(missing_commands)}")
    if not hasattr(socket, "AF_UNIX"):
        raise SystemExit("this prototype requires POSIX AF_UNIX sockets")
    if arguments.admission_only:
        if not arguments.session_id:
            raise SystemExit("--admission-only requires --session-id")
        lease_path = lease_path_for(arguments.session_id)
        try:
            acquire_lease(lease_path, {"state": "admission-only", "pid": os.getpid()})
        except FileExistsError:
            raise SystemExit(LEASE_CONFLICT_EXIT) from None
        subprocess.run(["trash-put", str(lease_path)], check=False)
        print("admission acquired; no Pi process was spawned")
        return
    missing_environment = [name for name in arguments.forward_env if name not in os.environ]
    if missing_environment:
        raise SystemExit(f"requested environment variables are not exported: {', '.join(missing_environment)}")
    forwarded_environment = {name: os.environ[name] for name in arguments.forward_env}
    Prototype(forwarded_environment, session_id=arguments.session_id).run()


if __name__ == "__main__":
    main()
