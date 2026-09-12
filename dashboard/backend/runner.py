"""Subprocess entrypoint that runs one Illuminator simulation.

Run as ``python -m dashboard.backend.runner --run-dir <dir>`` with the working
directory set to the repository root (the run manager does this). Reads
``spec.json`` from the run directory and reports progress by rewriting
``status.json``.

This is deliberately a separate process:

* Mosaik creates and owns an asyncio event loop, which would collide with the
  one uvicorn is already running (the notebooks paper over the same clash with
  ``nest_asyncio``).
* ``illuminator.engine.current_model`` is module-global state that the engine
  mutates while starting simulators, so two concurrent runs in one process would
  corrupt each other.
* A crashing or hanging simulation cannot take the web server down, and
  cancelling a run is just a signal.

It is also the *only* module in the dashboard that imports ``illuminator``.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import platform
import sys
import traceback
from pathlib import Path
from typing import Any, Dict


def _now() -> str:
    return _dt.datetime.now().isoformat(timespec="seconds")


class StatusWriter:
    """Writes ``status.json`` atomically so readers never see a partial file."""

    def __init__(self, run_dir: Path) -> None:
        self.path = run_dir / "status.json"
        self.tmp = run_dir / "status.json.tmp"
        self.state: Dict[str, Any] = {}

    def update(self, **fields: Any) -> None:
        self.state.update(fields)
        self.state["updated_at"] = _now()
        self.tmp.write_text(json.dumps(self.state, indent=2), encoding="utf-8")
        os.replace(self.tmp, self.path)


def run(run_dir: Path) -> int:
    spec = json.loads((run_dir / "spec.json").read_text(encoding="utf-8"))
    status = StatusWriter(run_dir)

    # Carry identity forward from the queued status written by the run manager.
    existing = {}
    if status.path.exists():
        try:
            existing = json.loads(status.path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            existing = {}
    status.state = dict(existing)

    status.update(
        state="running",
        started_at=_now(),
        pid=os.getpid(),
        python=platform.python_version(),
        error=None,
    )

    try:
        # Imported here, not at module scope, so that a failure to import the
        # engine is reported as a run error rather than an unexplained exit.
        from illuminator.engine import Simulation

        simulation = Simulation(spec["scenario"])

        # Data file paths always come from the dashboard: several committed
        # tutorial YAMLs point at files that no longer exist, and the notebooks
        # override them too.
        for model, path in (spec.get("csv_overrides") or {}).items():
            simulation.set_model_param(model_name=model, parameter="file_path", value=path)

        if spec.get("new_settings"):
            simulation.edit_models(spec["new_settings"])

        for update in spec.get("states") or []:
            simulation.set_model_state(
                model_name=update["model"], state=update["state"], value=update["value"]
            )

        simulation.set_scenario_param("start_time", spec["start_time"])
        simulation.set_scenario_param("end_time", spec["end_time"])

        simulation.set_monitor_param("file", spec["out_file"])
        if spec.get("monitor_items"):
            # The committed YAMLs monitor only a subset (some just one column);
            # the pack decides what the dashboard needs to plot.
            simulation.set_monitor_param("items", spec["monitor_items"])

        simulation.run()

    except BaseException as exc:  # noqa: BLE001 - report everything, including SystemExit
        status.update(
            state="error",
            finished_at=_now(),
            error={
                "type": type(exc).__name__,
                "message": str(exc),
                "traceback": traceback.format_exc(),
            },
        )
        # Printed too, so it lands in run.log next to the engine's own output.
        traceback.print_exc()
        return 1

    status.update(state="done", finished_at=_now(), error=None)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", required=True, help="run directory containing spec.json")
    args = parser.parse_args(argv)
    run_dir = Path(args.run_dir).resolve()
    if not (run_dir / "spec.json").exists():
        print(f"no spec.json in {run_dir}", file=sys.stderr)
        return 2
    return run(run_dir)


if __name__ == "__main__":
    sys.exit(main())
