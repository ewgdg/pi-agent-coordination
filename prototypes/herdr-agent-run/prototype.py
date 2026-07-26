#!/usr/bin/env python3
"""PROTOTYPE — prove Herdr/Pi Agent Run admission and termination boundaries.

Question: can a small Herdr-hosted runner fence one Pi session writer, prove RPC
readiness and binding, keep process/work/attention observations separate,
interrupt work semantically, and confirm the exact Pi incarnation terminated?

This is deliberately throwaway. It uses one runner process in a Herdr pane and
an independent controller-held pidfd. It is not a production backend design.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import select
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

SCRIPT_PATH = Path(__file__).resolve()
EXTENSION_PATH = SCRIPT_PATH.with_name("attention-extension.ts")
BOLD = "\033[1m"
DIM = "\033[2m"
RESET = "\033[0m"
DIALOG_METHODS = {"select", "confirm", "input", "editor"}


def emit(message: dict[str, Any]) -> None:
    print(json.dumps(message, separators=(",", ":")), flush=True)


def lease_key(session_directory: Path, session_id: str) -> str:
    identity = f"{session_directory.resolve()}\0{session_id}".encode()
    return hashlib.sha256(identity).hexdigest()


def acquire_lease(lease_path: Path, record: dict[str, Any]) -> None:
    lease_path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(lease_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as lease_file:
        json.dump(record, lease_file)
        lease_file.flush()
        os.fsync(lease_file.fileno())


def release_lease(lease_path: Path, fence_token: str) -> bool:
    try:
        record = json.loads(lease_path.read_text())
    except FileNotFoundError:
        return False
    if record.get("fenceToken") != fence_token:
        raise RuntimeError("lease fence token changed; refusing release")
    lease_path.unlink()
    return True


def send_fd(socket_path: Path, pidfd: int, metadata: dict[str, Any]) -> None:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as channel:
        channel.connect(str(socket_path))
        payload = json.dumps(metadata).encode()
        channel.sendmsg([payload], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, pidfd.to_bytes(4, sys.byteorder))])


def receive_fd(listener: socket.socket) -> tuple[int, dict[str, Any]]:
    connection, _ = listener.accept()
    with connection:
        payload, ancillary, _flags, _address = connection.recvmsg(65536, socket.CMSG_SPACE(4))
    for level, kind, data in ancillary:
        if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
            return int.from_bytes(data[:4], sys.byteorder), json.loads(payload)
    raise RuntimeError("runner did not transfer a pidfd")


@dataclass
class Observation:
    process: str = "alive"
    work: str = "settled"
    attention: str = "none"
    session_file: str | None = None
    session_id: str | None = None
    last_event: str = "RPC process spawned"
    pending_dialog_id: str | None = None
    event_counts: dict[str, int] = field(default_factory=dict)

    def event(self, event: dict[str, Any]) -> None:
        event_type = str(event.get("type", "unknown"))
        self.event_counts[event_type] = self.event_counts.get(event_type, 0) + 1
        self.last_event = event_type
        if event_type == "agent_start":
            self.work = "active"
        elif event_type == "agent_settled":
            self.work = "settled"
        elif event_type == "extension_ui_request" and event.get("method") in DIALOG_METHODS:
            self.attention = "input-required"
            self.pending_dialog_id = str(event["id"])

    def snapshot(self) -> dict[str, Any]:
        return {
            "process": self.process,
            "work": self.work,
            "attention": self.attention,
            "sessionFile": self.session_file,
            "sessionId": self.session_id,
            "pendingDialogId": self.pending_dialog_id,
            "lastEvent": self.last_event,
            "eventCounts": self.event_counts,
        }


class PiRpc:
    def __init__(self, process: subprocess.Popen[str]) -> None:
        self.process = process
        self.observation = Observation()
        self._condition = threading.Condition()
        self._responses: dict[str, dict[str, Any]] = {}
        self._reader = threading.Thread(target=self._read_stdout, daemon=True)
        self._reader.start()

    def _read_stdout(self) -> None:
        assert self.process.stdout is not None
        for line in self.process.stdout:
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            with self._condition:
                response_id = message.get("id")
                if message.get("type") == "response" and response_id:
                    self._responses[str(response_id)] = message
                else:
                    self.observation.event(message)
                self._condition.notify_all()
        with self._condition:
            self.observation.process = "terminated"
            self.observation.last_event = "stdout-closed"
            self._condition.notify_all()

    def send(self, command: dict[str, Any]) -> str:
        request_id = str(command.setdefault("id", str(uuid.uuid4())))
        assert self.process.stdin is not None
        self.process.stdin.write(json.dumps(command) + "\n")
        self.process.stdin.flush()
        return request_id

    def request(self, command: dict[str, Any], timeout: float = 30) -> dict[str, Any]:
        request_id = self.send(command)
        deadline = time.monotonic() + timeout
        with self._condition:
            while request_id not in self._responses:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError(f"Pi RPC response timed out: {command['type']}")
                self._condition.wait(remaining)
            return self._responses.pop(request_id)

    def wait_for(self, predicate, timeout: float = 30) -> bool:
        deadline = time.monotonic() + timeout
        with self._condition:
            while not predicate(self.observation):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._condition.wait(remaining)
            return True


class Runner:
    def __init__(self, arguments: argparse.Namespace) -> None:
        self.arguments = arguments
        self.lease_path = Path(arguments.lease_path)
        self.fence_token = str(uuid.uuid4())
        self.run_id = str(uuid.uuid4())
        self.pi: PiRpc | None = None
        self.child: subprocess.Popen[str] | None = None
        self.pidfd: int | None = None

    def start(self) -> None:
        session_directory = Path(self.arguments.session_directory).resolve()
        record = {
            "sessionKey": f"{session_directory}:{self.arguments.session_id}",
            "runId": self.run_id,
            "fenceToken": self.fence_token,
            "state": "admitting",
        }
        acquire_lease(self.lease_path, record)

        pi_command = [
            shutil.which("pi") or "pi",
            "--mode",
            "rpc",
            "--session-dir",
            str(session_directory),
            "--session-id",
            self.arguments.session_id,
            "--extension",
            str(EXTENSION_PATH),
            "--no-skills",
            "--no-prompt-templates",
        ]
        self.child = subprocess.Popen(
            pi_command,
            cwd=self.arguments.working_directory,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )
        self.pidfd = os.pidfd_open(self.child.pid)
        self.pi = PiRpc(self.child)

        response = self.pi.request({"id": "readiness", "type": "get_state"})
        data = response.get("data", {})
        actual_file = Path(str(data.get("sessionFile", ""))).resolve()
        actual_id = data.get("sessionId")
        binding_ok = (
            response.get("success") is True
            and actual_id == self.arguments.session_id
            and actual_file.parent == session_directory
            and self.child.poll() is None
        )
        if not binding_ok:
            signal.pidfd_send_signal(self.pidfd, signal.SIGTERM)
            self.child.wait(timeout=10)
            release_lease(self.lease_path, self.fence_token)
            raise RuntimeError(f"readiness binding rejected: {response}")

        self.pi.observation.session_file = str(actual_file)
        self.pi.observation.session_id = str(actual_id)
        record.update({"state": "ready", "pid": self.child.pid, "sessionFile": str(actual_file)})
        self.lease_path.write_text(json.dumps(record))
        send_fd(
            Path(self.arguments.fd_socket),
            self.pidfd,
            {
                "pid": self.child.pid,
                "runId": self.run_id,
                "fenceToken": self.fence_token,
                "leasePath": str(self.lease_path),
                "sessionFile": str(actual_file),
                "sessionId": str(actual_id),
            },
        )
        self.serve()

    def serve(self) -> None:
        control_path = Path(self.arguments.control_socket)
        control_path.unlink(missing_ok=True)
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
            server.bind(str(control_path))
            server.listen()
            while True:
                connection, _ = server.accept()
                with connection:
                    request = json.loads(connection.recv(65536))
                    try:
                        response = self.handle(request)
                    except Exception as error:
                        response = {"ok": False, "error": f"{type(error).__name__}: {error}"}
                    connection.sendall(json.dumps(response).encode())
                if request.get("command") == "detach":
                    return

    def handle(self, request: dict[str, Any]) -> dict[str, Any]:
        assert self.pi is not None
        command = request.get("command")
        if command == "snapshot":
            return {"ok": True, "observation": self.pi.observation.snapshot()}
        if command == "verify-binding":
            expected_id = request.get("expectedSessionId")
            state = self.pi.request({"type": "get_state"})
            actual_id = state.get("data", {}).get("sessionId")
            return {"ok": actual_id == expected_id, "expected": expected_id, "actual": actual_id}
        if command == "attention":
            self.pi.send({"id": "attention-prompt", "type": "prompt", "message": "/prototype-attention"})
            appeared = self.pi.wait_for(lambda state: state.attention == "input-required", timeout=10)
            return {"ok": appeared}
        if command == "answer-attention":
            dialog_id = self.pi.observation.pending_dialog_id
            if not dialog_id:
                return {"ok": False, "error": "no pending dialog"}
            assert self.child is not None and self.child.stdin is not None
            self.child.stdin.write(json.dumps({"type": "extension_ui_response", "id": dialog_id, "value": "released"}) + "\n")
            self.child.stdin.flush()
            self.pi.observation.attention = "none"
            self.pi.observation.pending_dialog_id = None
            return {"ok": True}
        if command == "start-work":
            response = self.pi.request(
                {
                    "type": "prompt",
                    "message": "Use the bash tool to run `sleep 60`. Do not do anything else.",
                }
            )
            active = self.pi.wait_for(lambda state: state.work == "active", timeout=15)
            return {"ok": response.get("success") is True and active, "rpc": response}
        if command == "steer":
            return self.pi.request({"type": "steer", "message": "Stop the current approach and wait for further instructions."})
        if command == "abort":
            response = self.pi.request({"type": "abort"})
            settled = self.pi.wait_for(lambda state: state.work == "settled", timeout=30)
            return {
                "ok": response.get("success") is True and settled and self.child is not None and self.child.poll() is None,
                "rpc": response,
                "settled": settled,
                "processAlive": self.child is not None and self.child.poll() is None,
            }
        if command == "detach":
            return {"ok": True, "note": "runner detached without releasing the lease"}
        return {"ok": False, "error": f"unknown command: {command}"}


def call_runner(control_path: Path, command: str, **fields: Any) -> dict[str, Any]:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(45)
        client.connect(str(control_path))
        client.sendall(json.dumps({"command": command, **fields}).encode())
        payload = client.recv(65536)
    if not payload:
        raise ConnectionError("runner closed the control connection without a response")
    return json.loads(payload)


def parse_pane_id(payload: str) -> str:
    response = json.loads(payload)
    return str(response["result"]["pane"]["pane_id"])


@dataclass
class ControllerState:
    pane_id: str
    control_path: Path
    lease_path: Path
    pidfd: int
    metadata: dict[str, Any]
    independent_exit_confirmed: bool = False
    lease_released_after_exit: bool = False
    pane_closed: bool = False
    last_proof: str = "Runner admitted after correlated get_state binding proof"


class Controller:
    def __init__(self) -> None:
        self.scratch = Path(tempfile.mkdtemp(prefix="herdr-agent-run-prototype."))
        self.session_directory = self.scratch / "sessions"
        self.session_directory.mkdir()
        self.session_id = str(uuid.uuid4())
        leases = self.scratch / "leases"
        self.lease_path = leases / f"{lease_key(self.session_directory, self.session_id)}.json"
        self.control_path = self.scratch / "control.sock"
        self.fd_path = self.scratch / "pidfd.sock"
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener.bind(str(self.fd_path))
        self.listener.listen()
        self.state = self._launch()
        self._start_exit_watcher()

    def _launch(self) -> ControllerState:
        split = subprocess.run(
            ["herdr", "pane", "split", "--current", "--direction", "down", "--ratio", "0.20", "--cwd", str(SCRIPT_PATH.parent), "--no-focus"],
            check=True,
            text=True,
            capture_output=True,
        )
        pane_id = parse_pane_id(split.stdout)
        runner_command = [
            sys.executable,
            str(SCRIPT_PATH),
            "runner",
            "--control-socket",
            str(self.control_path),
            "--fd-socket",
            str(self.fd_path),
            "--lease-path",
            str(self.lease_path),
            "--session-directory",
            str(self.session_directory),
            "--session-id",
            self.session_id,
            "--working-directory",
            str(Path.cwd()),
        ]
        subprocess.run(["herdr", "pane", "run", pane_id, *runner_command], check=True, capture_output=True, text=True)
        self.listener.settimeout(30)
        pidfd, metadata = receive_fd(self.listener)
        deadline = time.monotonic() + 10
        while not self.control_path.exists():
            if time.monotonic() >= deadline:
                raise TimeoutError("runner control socket did not appear")
            time.sleep(0.05)
        return ControllerState(pane_id, self.control_path, self.lease_path, pidfd, metadata)

    def _start_exit_watcher(self) -> None:
        def watch() -> None:
            poller = select.poll()
            poller.register(self.state.pidfd, select.POLLIN)
            poller.poll()
            self.state.independent_exit_confirmed = True
            self.state.lease_released_after_exit = release_lease(
                self.state.lease_path, str(self.state.metadata["fenceToken"])
            )
            self.state.last_proof = "Independent pidfd became readable; matching fenced lease released"

        threading.Thread(target=watch, daemon=True).start()

    def runner(self, command: str, **fields: Any) -> dict[str, Any]:
        if self.state.pane_closed:
            return {"ok": False, "error": "runner pane is closed; observation channel is unavailable"}
        try:
            return call_runner(self.state.control_path, command, **fields)
        except (ConnectionError, FileNotFoundError, socket.timeout) as error:
            return {"ok": False, "error": str(error)}

    def process_state(self) -> str:
        poller = select.poll()
        poller.register(self.state.pidfd, select.POLLIN)
        return "terminated" if poller.poll(0) else "alive"

    def attempt_second_writer(self) -> str:
        try:
            acquire_lease(self.lease_path, {"fenceToken": "loser", "state": "must-not-spawn"})
        except FileExistsError:
            return "PASS — second launch rejected before spawning Pi"
        release_lease(self.lease_path, "loser")
        return "FAIL — second launch acquired the live session lease"

    def terminate_exact(self) -> None:
        if self.process_state() == "alive":
            signal.pidfd_send_signal(self.state.pidfd, signal.SIGTERM)
            deadline = time.monotonic() + 5
            while self.process_state() == "alive" and time.monotonic() < deadline:
                time.sleep(0.05)
            if self.process_state() == "alive":
                signal.pidfd_send_signal(self.state.pidfd, signal.SIGKILL)
        deadline = time.monotonic() + 10
        while not self.state.independent_exit_confirmed and time.monotonic() < deadline:
            time.sleep(0.05)
        if not self.state.independent_exit_confirmed:
            raise TimeoutError("independent pidfd watcher did not confirm termination")

    def close_pane(self) -> None:
        if not self.state.pane_closed:
            self.state.last_proof = "pane.close requested; awaiting independent pidfd exit proof"
            subprocess.run(["herdr", "pane", "close", self.state.pane_id], check=False, capture_output=True)
            self.state.pane_closed = True

    def cleanup(self) -> None:
        try:
            self.terminate_exact()
        finally:
            self.close_pane()

    def render(self) -> None:
        observation = self.runner("snapshot")
        observed = observation.get("observation", {})
        process = self.process_state()
        work = observed.get("work", "unknown")
        attention = observed.get("attention", "unknown")
        lease = "held" if self.lease_path.exists() else "released"
        os.system("clear")
        print(f"{BOLD}PROTOTYPE — Herdr Agent Run admission and termination{RESET}\n")
        print(f"{BOLD}process{RESET}:   {process}  {DIM}(independent pidfd){RESET}")
        print(f"{BOLD}work{RESET}:      {work}  {DIM}(Pi agent events){RESET}")
        print(f"{BOLD}attention{RESET}: {attention}  {DIM}(Pi dialog request){RESET}")
        print(f"{BOLD}lease{RESET}:     {lease}")
        print(f"{BOLD}pane{RESET}:      {self.state.pane_id} ({'closed' if self.state.pane_closed else 'open'})")
        print(f"{BOLD}session{RESET}:   {self.state.metadata['sessionId']}")
        print(f"{BOLD}file{RESET}:      {self.state.metadata['sessionFile']}")
        print(f"{BOLD}last proof{RESET}: {self.state.last_proof}\n")
        print(f"{BOLD}[a]{RESET} second-writer admission   {BOLD}[b]{RESET} wrong-binding rejection")
        print(f"{BOLD}[i]{RESET} require input attention   {BOLD}[r]{RESET} answer input")
        print(f"{BOLD}[w]{RESET} start long agent work     {BOLD}[s]{RESET} steer work   {BOLD}[x]{RESET} abort work")
        print(f"{BOLD}[c]{RESET} close Herdr pane          {BOLD}[k]{RESET} exact pidfd termination")
        print(f"{BOLD}[q]{RESET} quit and clean up")

    def run(self) -> None:
        try:
            while True:
                self.render()
                key = input("\nAction: ").strip().lower()
                if key == "a":
                    self.state.last_proof = self.attempt_second_writer()
                elif key == "b":
                    result = self.runner("verify-binding", expectedSessionId="deliberately-wrong")
                    rejected = result.get("ok") is False and result.get("actual") == self.session_id
                    self.state.last_proof = "PASS — mismatched session ID rejected" if rejected else f"FAIL — binding probe: {result}"
                elif key == "i":
                    result = self.runner("attention")
                    self.state.last_proof = f"attention request: {result.get('ok')}"
                elif key == "r":
                    result = self.runner("answer-attention")
                    self.state.last_proof = f"attention released: {result.get('ok')}"
                elif key == "w":
                    result = self.runner("start-work")
                    self.state.last_proof = "Pi accepted work and emitted agent_start" if result.get("ok") else f"work probe failed: {result}"
                elif key == "s":
                    result = self.runner("steer")
                    self.state.last_proof = f"semantic steer acknowledged: {result.get('success', result.get('ok'))}"
                elif key == "x":
                    result = self.runner("abort")
                    self.state.last_proof = "PASS — abort settled work and Pi stayed alive" if result.get("ok") else f"abort probe failed: {result}"
                elif key == "c":
                    self.close_pane()
                elif key == "k":
                    self.terminate_exact()
                elif key == "q":
                    return
        finally:
            self.cleanup()


def run_controller() -> None:
    required = ["herdr", "pi"]
    missing = [command for command in required if not shutil.which(command)]
    if missing:
        raise SystemExit(f"missing required commands: {', '.join(missing)}")
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        raise SystemExit("this prototype requires Linux pidfd support")
    Controller().run()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="mode")
    runner = subparsers.add_parser("runner")
    runner.add_argument("--control-socket", required=True)
    runner.add_argument("--fd-socket", required=True)
    runner.add_argument("--lease-path", required=True)
    runner.add_argument("--session-directory", required=True)
    runner.add_argument("--session-id", required=True)
    runner.add_argument("--working-directory", required=True)
    return parser


def main() -> None:
    arguments = build_parser().parse_args()
    if arguments.mode == "runner":
        Runner(arguments).start()
    else:
        run_controller()


if __name__ == "__main__":
    main()
