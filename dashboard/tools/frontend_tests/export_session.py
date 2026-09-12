"""Export real backend payloads for the frontend tests to replay.

Runs an actual simulation through the FastAPI app in-process and writes the
resulting payloads to ``$TMPDIR/live/session.json``, which ``test-app.mjs`` and
``test-edges.mjs`` load. Using real payloads rather than hand-written ones keeps
the frontend tests honest about what the backend actually sends.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path

from dashboard.tools.capture_fixtures import asgi_request, run_lifespan


def main() -> int:
    from dashboard.backend.app import app

    out_dir = Path(os.environ.get("TMPDIR", tempfile.gettempdir())) / "live"
    out_dir.mkdir(parents=True, exist_ok=True)

    run_lifespan(app, "startup")
    try:
        def get(path: str, query: str = ""):
            status, payload = asgi_request(app, "GET", path, query)
            if status != 200:
                raise RuntimeError(f"GET {path} -> {status}: {payload}")
            return payload

        session = {
            "packs": get("/api/packs"),
            "baseline": get("/api/packs/power_balance/cases/base/baseline",
                            "day=2012-06-01&houses=5"),
            "topology": get("/api/packs/power_balance/cases/res_battery/topology"),
        }

        status, created = asgi_request(app, "POST", "/api/runs", "", {
            "pack": "power_balance", "case": "res_battery", "day": "2012-06-01",
            "states": {"soc_start": 90},
        })
        if status != 201:
            raise RuntimeError(f"could not start a run: {status} {created}")
        session["created"] = created
        run_id = created["id"]

        while True:
            run_status = get(f"/api/runs/{run_id}")
            if run_status["state"] not in ("queued", "running"):
                break
            time.sleep(0.05)
        if run_status["state"] != "done":
            raise RuntimeError(f"run did not finish cleanly: {run_status['state']}")

        session["status_done"] = run_status
        session["results_full"] = get(f"/api/runs/{run_id}/results")
        session["summary"] = get(f"/api/runs/{run_id}/summary")
    finally:
        run_lifespan(app, "shutdown")

    target = out_dir / "session.json"
    target.write_text(json.dumps(session, indent=1), encoding="utf-8")
    print(f"wrote {target} ({len(session['results_full']['rows'])} result rows)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
