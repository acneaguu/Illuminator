"""Manages simulation runs: spawning, progress, cancellation and history.

Each run owns a directory under ``dashboard/runs/`` containing everything needed
to reproduce or debug it:

``spec.json``
    The full resolved description of the run (scenario, absolute data paths,
    settings, monitor items) -- written by this module, read by the runner.
``status.json``
    State machine written by the runner subprocess: queued -> running ->
    done | error, or cancelled if we kill it.
``out.csv``
    The Collector's output, appended one row per simulation step.
``run.log``
    Everything the engine and Mosaik print (both are chatty).

The server process never imports :mod:`illuminator`; only the runner subprocess
does. Progress is therefore derived by counting rows in ``out.csv`` against a
step count computed with the same arithmetic the engine uses.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import packs, results

#: How many simulations may run at once. One by default: the Illuminator uses a
#: lot of CPU per run, the dashboard shows one at a time, and a Raspberry Pi
#: would not benefit from more.
MAX_CONCURRENT = 1

#: Grace period between SIGTERM and SIGKILL when cancelling.
KILL_GRACE_SECONDS = 5.0

ACTIVE_STATES = ("queued", "running")


class RunError(Exception):
    """Raised for run requests that cannot be satisfied."""


class RunConflict(RunError):
    """Raised when a run cannot start because another is still active."""


def _now() -> str:
    return _dt.datetime.now().isoformat(timespec="seconds")


class Run:
    """One simulation run and the process behind it."""

    def __init__(self, run_id: str, directory: Path, spec: Dict[str, Any],
                 process: Optional[subprocess.Popen] = None,
                 log_handle: Optional[Any] = None) -> None:
        self.id = run_id
        self.dir = directory
        self.spec = spec
        self.process = process
        self.log_handle = log_handle
        self.created_at = _now()
        self.notes: List[str] = []

    # -- files ------------------------------------------------------------
    @property
    def out_file(self) -> Path:
        return self.dir / "out.csv"

    @property
    def status_file(self) -> Path:
        return self.dir / "status.json"

    @property
    def log_file(self) -> Path:
        return self.dir / "run.log"

    def read_status_file(self) -> Dict[str, Any]:
        if not self.status_file.exists():
            return {}
        try:
            return json.loads(self.status_file.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            # A read that races the runner's atomic replace: treat as unknown.
            return {}

    def write_status_file(self, **fields: Any) -> None:
        current = self.read_status_file()
        current.update(fields)
        current["updated_at"] = _now()
        tmp = self.dir / "status.json.tmp"
        tmp.write_text(json.dumps(current, indent=2), encoding="utf-8")
        os.replace(tmp, self.status_file)

    # -- process ----------------------------------------------------------
    def poll(self) -> Optional[int]:
        return self.process.poll() if self.process else None

    def reap(self) -> None:
        """Close the log handle once the child has exited."""
        if self.process and self.process.poll() is not None and self.log_handle:
            try:
                self.log_handle.close()
            finally:
                self.log_handle = None

    def log_tail(self, lines: int = 40) -> str:
        if not self.log_file.exists():
            return ""
        text = self.log_file.read_text(encoding="utf-8", errors="replace")
        return "\n".join(text.splitlines()[-lines:])

    # -- status -----------------------------------------------------------
    def status(self) -> Dict[str, Any]:
        """Merge the runner's own status with what we can see of the process."""
        self.reap()
        status = self.read_status_file()
        state = status.get("state", "queued")
        exit_code = self.poll()

        # The child can die without recording anything (import error, OOM,
        # SIGKILL). Trust the process over a stale status file.
        if state in ACTIVE_STATES and self.process is not None and exit_code is not None:
            if exit_code == 0:
                state = "done"
            else:
                state = "error"
                status.setdefault("error", {
                    "type": "ProcessExited",
                    "message": f"simulation process exited with code {exit_code}",
                    "traceback": self.log_tail(),
                })
            self.write_status_file(state=state, finished_at=_now(),
                                   error=status.get("error"), exit_code=exit_code)

        rows = results.row_count(self.out_file)
        expected = int(self.spec.get("expected_steps") or 0)
        progress = min(1.0, rows / expected) if expected else 0.0
        if state == "done":
            progress = 1.0

        return {
            "id": self.id,
            "pack": self.spec.get("pack"),
            "case": self.spec.get("case"),
            "title": self.spec.get("title"),
            "day": self.spec.get("day"),
            "state": state,
            "progress": round(progress, 4),
            "rows": rows,
            "expected_steps": expected,
            "created_at": self.created_at,
            "started_at": status.get("started_at"),
            "finished_at": status.get("finished_at"),
            "error": status.get("error"),
            "exit_code": exit_code,
            "settings": self.spec.get("settings", {}),
            "state_values": self.spec.get("state_values", {}),
            "monitor_items": self.spec.get("monitor_items", []),
            "notes": self.notes,
        }

    def is_active(self) -> bool:
        return self.status()["state"] in ACTIVE_STATES

    def cancel(self) -> Dict[str, Any]:
        """Stop the run, killing the whole process group.

        Mosaik starts simulators as children of the runner, so signalling only
        the runner would leave them behind; the runner is started in its own
        session precisely so the group can be signalled as a unit.
        """
        if self.process is None or self.process.poll() is not None:
            status = self.status()
            if status["state"] in ACTIVE_STATES:
                self.write_status_file(state="cancelled", finished_at=_now())
                return self.status()
            return status

        try:
            os.killpg(os.getpgid(self.process.pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            self.process.terminate()

        deadline = time.monotonic() + KILL_GRACE_SECONDS
        while time.monotonic() < deadline and self.process.poll() is None:
            time.sleep(0.05)

        if self.process.poll() is None:
            try:
                os.killpg(os.getpgid(self.process.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                self.process.kill()
            self.process.wait(timeout=5)

        self.reap()
        self.write_status_file(state="cancelled", finished_at=_now())
        return self.status()


class RunManager:
    """Registry of runs, and the only thing that starts simulation processes."""

    def __init__(self, runs_dir: Optional[Path] = None,
                 max_concurrent: int = MAX_CONCURRENT) -> None:
        self.runs_dir = runs_dir or packs.RUNS_DIR
        self.runs_dir.mkdir(parents=True, exist_ok=True)
        self.max_concurrent = max_concurrent
        self._runs: Dict[str, Run] = {}
        self._lock = threading.Lock()
        self._adopt_existing()

    # -- discovery --------------------------------------------------------
    def _adopt_existing(self) -> None:
        """Register runs left on disk by earlier server processes.

        Their processes are gone, so anything still marked active is recorded as
        interrupted rather than left looking like it is running.
        """
        for directory in sorted(self.runs_dir.iterdir() if self.runs_dir.exists() else []):
            spec_file = directory / "spec.json"
            if not directory.is_dir() or not spec_file.exists():
                continue
            try:
                spec = json.loads(spec_file.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue
            run = Run(directory.name, directory, spec)
            status = run.read_status_file()
            if status.get("state") in ACTIVE_STATES:
                run.write_status_file(
                    state="error",
                    finished_at=_now(),
                    error={"type": "Interrupted",
                           "message": "the server restarted while this run was active",
                           "traceback": run.log_tail()},
                )
            run.created_at = status.get("started_at") or run.created_at
            self._runs[run.id] = run

    # -- queries ----------------------------------------------------------
    def get(self, run_id: str) -> Run:
        run = self._runs.get(run_id)
        if run is None:
            raise KeyError(f"no such run: {run_id}")
        return run

    def list(self) -> List[Dict[str, Any]]:
        with self._lock:
            runs = list(self._runs.values())
        return sorted((r.status() for r in runs),
                      key=lambda s: s["created_at"], reverse=True)

    def active_runs(self) -> List[Run]:
        with self._lock:
            runs = list(self._runs.values())
        return [r for r in runs if r.is_active()]

    # -- creation ---------------------------------------------------------
    def _allocate_dir(self, pack_id: str, case_id: str) -> tuple:
        stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        base = f"{stamp}-{pack_id}-{case_id}"
        candidate, suffix = base, 1
        while (self.runs_dir / candidate).exists():
            suffix += 1
            candidate = f"{base}-{suffix}"
        directory = self.runs_dir / candidate
        directory.mkdir(parents=True)
        return candidate, directory

    def create(self, pack_id: str, case_id: str, day: Optional[str] = None,
               settings: Optional[Dict[str, Any]] = None,
               states: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Validate a request, write its spec and start the simulation."""
        pack, case = packs.get_case(pack_id, case_id)
        if case["kind"] != "simulation":
            raise RunError(
                f"case '{pack_id}/{case_id}' is a dataset view, not a simulation; "
                "use the baseline endpoint"
            )

        resolved_day = packs.validate_day(case, day)
        resolved_settings, notes = packs.resolve_settings(case, settings)
        resolved_states, state_notes = packs.resolve_states(case, states)
        notes = notes + state_notes

        with self._lock:
            active = [r for r in self._runs.values() if r.is_active()]
            if len(active) >= self.max_concurrent:
                raise RunConflict(
                    f"a simulation is already running ({active[0].id}); "
                    "cancel it or wait for it to finish"
                )

            run_id, directory = self._allocate_dir(pack_id, case_id)
            spec = packs.build_spec(pack, case, resolved_day, resolved_settings,
                                    resolved_states, directory / "out.csv")
            (directory / "spec.json").write_text(json.dumps(spec, indent=2), encoding="utf-8")

            run = Run(run_id, directory, spec)
            run.notes = notes
            run.write_status_file(state="queued", id=run_id, created_at=run.created_at)

            log_handle = open(run.log_file, "wb")
            try:
                process = subprocess.Popen(
                    [sys.executable, "-m", "dashboard.backend.runner",
                     "--run-dir", str(directory)],
                    # The engine resolves several paths (including the monitor
                    # file directory it validates at load time) relative to the
                    # working directory, and the tutorial YAMLs are written
                    # relative to the repository root.
                    cwd=str(packs.REPO_ROOT),
                    stdout=log_handle,
                    stderr=subprocess.STDOUT,
                    # Own session, so cancelling can signal the whole group:
                    # Mosaik spawns the simulators as further children.
                    start_new_session=True,
                )
            except Exception:
                log_handle.close()
                raise

            run.process = process
            run.log_handle = log_handle
            self._runs[run_id] = run

        return run.status()

    # -- lifecycle --------------------------------------------------------
    def cancel(self, run_id: str) -> Dict[str, Any]:
        return self.get(run_id).cancel()

    def results(self, run_id: str, since: int = 0,
                limit: Optional[int] = None) -> Dict[str, Any]:
        run = self.get(run_id)
        status = run.status()
        payload = results.read_results(run.out_file, since=since, limit=limit)
        payload.update({
            "id": run.id,
            "state": status["state"],
            "progress": status["progress"],
            "expected_steps": status["expected_steps"],
            "complete": status["state"] not in ACTIVE_STATES,
        })
        return payload

    def summary(self, run_id: str) -> Dict[str, Any]:
        run = self.get(run_id)
        _, case = packs.get_case(run.spec["pack"], run.spec["case"])
        summary_spec = case.get("summary") or {}
        payload = results.hourly_summary(
            run.out_file,
            sum_columns=summary_spec.get("sum_columns") or {},
            sample_columns=summary_spec.get("sample_columns") or {},
        )
        payload["id"] = run.id
        return payload

    def ranges(self, run_id: str) -> Dict[str, Any]:
        run = self.get(run_id)
        return {"id": run.id, "ranges": results.column_ranges(run.out_file)}

    def log(self, run_id: str, tail: int = 100) -> Dict[str, Any]:
        run = self.get(run_id)
        return {"id": run.id, "log": run.log_tail(tail)}

    def shutdown(self) -> None:
        """Cancel anything still running, so the server does not orphan children."""
        for run in list(self._runs.values()):
            if run.process is not None and run.process.poll() is None:
                try:
                    run.cancel()
                except Exception:  # noqa: BLE001 - best effort on the way out
                    pass
