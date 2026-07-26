#!/usr/bin/env python3
"""PROTOTYPE — test native interactive Pi Agent Run boundaries in Herdr.

Question: can a normal Pi TUI enforce cooperating single-writer admission, prove
its intended session binding, expose process/work/attention observations, use
Pi-native steer/abort/Human Requests, and terminate through Pi itself?

This is throwaway evidence. It deliberately does not add RPC mode, a custom
control socket, pidfds, signal handling, or a replacement UI.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

SCRIPT_PATH = Path(__file__).resolve()
EXTENSION_PATH = SCRIPT_PATH.with_name("agent-run-extension.ts")
BOLD = "\033[1m"
DIM = "\033[2m"
RESET = "\033[0m"


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


def acquire_lease(lease_path: Path, record: dict[str, Any]) -> None:
    lease_path.parent.mkdir(parents=True, exist_ok=True)
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
    def __init__(self) -> None:
        self.scratch = Path(tempfile.mkdtemp(prefix="herdr-interactive-run-prototype."))
        self.session_directory = self.scratch / "sessions"
        self.session_directory.mkdir()
        self.session_id = str(uuid.uuid4())
        self.agent_name = f"agent-run-proof-{self.session_id[:8]}"
        self.run_token = str(uuid.uuid4())
        self.lease_path = self.scratch / "leases" / f"{self.session_id}.json"
        self.pane_id: str | None = None
        self.last_proof = "Not launched"
        self.shutdown_requested = False

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
        split = run_json(
            [
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
        )
        self.pane_id = parse_pane_id(split)
        try:
            self.start_agent_when_shell_ready()
            session_path = self.wait_for_session_path()
            if not self.binding_matches(session_path):
                self.request_shutdown()
                raise RuntimeError(
                    f"interactive readiness bound the wrong session: expected {self.session_id} in "
                    f"{self.session_directory}, observed {session_path}"
                )
            record = json.loads(self.lease_path.read_text())
            record.update({"state": "ready", "paneId": self.pane_id, "sessionFile": session_path})
            self.lease_path.write_text(json.dumps(record))
            self.last_proof = "PASS — normal Pi TUI ready with intended session binding"
        except Exception:
            self.close_pane()
            raise

    def start_agent_when_shell_ready(self) -> None:
        assert self.pane_id is not None
        command = [
            "herdr",
            "agent",
            "start",
            self.agent_name,
            "--kind",
            "pi",
            "--pane",
            self.pane_id,
            "--timeout",
            "30000",
            "--",
            "--session-dir",
            str(self.session_directory),
            "--session-id",
            self.session_id,
            "--extension",
            str(EXTENSION_PATH),
            "--no-skills",
            "--no-prompt-templates",
        ]
        deadline = time.monotonic() + 10
        while True:
            response = run_json(command, check=False)
            if response.get("returncode") == 0:
                return
            error_code = find_first(response, {"code"})
            # A newly split pane exists before its interactive shell reaches a prompt.
            if error_code != "agent_pane_busy" or time.monotonic() >= deadline:
                raise RuntimeError(f"Herdr could not start interactive Pi: {response}")
            time.sleep(0.1)

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

    def binding_matches(self, session_path: str | None) -> bool:
        if not session_path:
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
        elif herdr_status == "idle":
            work = "settled"
        elif herdr_status == "blocked":
            # Herdr's single status gives attention precedence, so it cannot also prove work state.
            work = "unknown while attention is projected"
        else:
            work = "unknown"
        attention = "input-required" if herdr_status == "blocked" else "none" if herdr_status in {"idle", "working"} else "unknown"
        return Snapshot(process_state, work, attention, herdr_status, find_session_path(agent), pi_pid)

    def attempt_second_writer(self) -> None:
        try:
            acquire_lease(self.lease_path, {"runToken": "loser", "state": "must-not-spawn"})
        except FileExistsError:
            self.last_proof = "PASS — second cooperating launch rejected before Pi spawn"
            return
        self.last_proof = "FAIL — second launch acquired the live session lease"

    def send_prompt(self, text: str) -> dict[str, Any]:
        return run_json(["herdr", "agent", "prompt", self.agent_name, text], check=False)

    def wait_for_status(self, desired: set[str], timeout: float = 30) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.snapshot().herdr_status in desired:
                return True
            time.sleep(0.2)
        return False

    def request_human_input(self) -> None:
        response = self.send_prompt("/prototype-request")
        blocked = self.wait_for_status({"blocked"}, timeout=10)
        self.last_proof = (
            "PASS — Human Request is waiting in the normal Pi panel"
            if blocked
            else f"Human Request did not reach blocked state: {response}"
        )

    def start_work(self) -> None:
        response = self.send_prompt("Use the bash tool to run `sleep 60`. Do not do anything else.")
        working = self.wait_for_status({"working"}, timeout=15)
        self.last_proof = "PASS — normal Pi work became active" if working else f"Work did not become active: {response}"

    def steer(self) -> None:
        response = self.send_prompt("/prototype-steer")
        self.last_proof = f"Pi steering command submitted through its normal TUI: {response.get('returncode') == 0}"

    def abort(self) -> None:
        response = self.send_prompt("/prototype-abort")
        settled = self.wait_for_status({"idle"}, timeout=30)
        process_present = self.snapshot().pi_pid is not None
        self.last_proof = (
            "PASS — Pi abort settled work; Pi remains alive. Idle-close is downstream policy."
            if settled and process_present
            else f"Abort boundary not observed: settled={settled}, processPresent={process_present}, response={response}"
        )

    def request_shutdown(self) -> None:
        if self.shutdown_requested:
            return
        if self.snapshot().herdr_status == "blocked":
            run_json(["herdr", "agent", "send-keys", self.agent_name, "esc"], check=False)
            self.wait_for_status({"idle"}, timeout=5)
        self.shutdown_requested = True
        response = self.send_prompt("/prototype-shutdown")
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and self.snapshot().pi_pid is not None:
            time.sleep(0.2)
        pi_absent = self.snapshot().pi_pid is None
        self.last_proof = (
            "Pi requested graceful shutdown and is no longer observed; exact-incarnation exit remains unproven"
            if pi_absent
            else f"Pi shutdown was requested but Pi remains observed: {response}"
        )

    def render(self) -> None:
        state = self.snapshot()
        os.system("clear")
        print(f"{BOLD}PROTOTYPE — normal interactive Pi Agent Run{RESET}\n")
        print(f"{BOLD}process presence{RESET}: {state.process}")
        print(f"{BOLD}work{RESET}:             {state.work}")
        print(f"{BOLD}attention{RESET}:        {state.attention}")
        print(f"{BOLD}Herdr status{RESET}:      {state.herdr_status}")
        print(f"{BOLD}lease{RESET}:             {'held' if self.lease_path.exists() else 'missing'}")
        print(f"{BOLD}session expected{RESET}:  {self.session_id}")
        print(f"{BOLD}session observed{RESET}:  {state.session_path or 'unknown'}")
        print(f"{BOLD}pane{RESET}:              {self.pane_id}")
        print(f"{BOLD}last proof{RESET}:        {self.last_proof}\n")
        print(f"{BOLD}[a]{RESET} reject second writer       {BOLD}[b]{RESET} verify session binding")
        print(f"{BOLD}[i]{RESET} open Human Request         {BOLD}[p]{RESET} refresh observations")
        print(f"{BOLD}[w]{RESET} start long work            {BOLD}[s]{RESET} semantic steer")
        print(f"{BOLD}[x]{RESET} semantic abort             {BOLD}[k]{RESET} ask Pi to shut down")
        print(f"{BOLD}[q]{RESET} explicit prototype cleanup")
        print(f"\n{DIM}Answer Human Requests in the Pi pane itself. The lease is never auto-released from disappearance alone.{RESET}")

    def close_pane(self) -> None:
        if self.pane_id:
            run_json(["herdr", "pane", "close", self.pane_id], check=False)
            self.pane_id = None

    def cleanup(self) -> None:
        if self.pane_id and self.snapshot().pi_pid is not None:
            self.request_shutdown()
        self.close_pane()
        if self.scratch.exists():
            subprocess.run(["trash-put", str(self.scratch)], check=False)

    def run(self) -> None:
        try:
            self.launch()
            while True:
                self.render()
                try:
                    action = input("\nAction: ").strip().lower()
                except EOFError:
                    self.last_proof = "No interactive stdin; run this command in a normal terminal"
                    return
                if action == "a":
                    self.attempt_second_writer()
                elif action == "b":
                    observed = self.snapshot().session_path
                    self.last_proof = (
                        "PASS — Herdr reports the intended Pi session"
                        if self.binding_matches(observed)
                        else f"FAIL — binding mismatch: {observed}"
                    )
                elif action == "i":
                    self.request_human_input()
                elif action == "p":
                    self.last_proof = "Observations refreshed without collapsing their meanings"
                elif action == "w":
                    self.start_work()
                elif action == "s":
                    self.steer()
                elif action == "x":
                    self.abort()
                elif action == "k":
                    self.request_shutdown()
                elif action == "q":
                    return
        finally:
            self.cleanup()


def main() -> None:
    missing = [command for command in ("herdr", "pi", "trash-put") if not shutil.which(command)]
    if missing:
        raise SystemExit(f"missing required commands: {', '.join(missing)}")
    Prototype().run()


if __name__ == "__main__":
    main()
