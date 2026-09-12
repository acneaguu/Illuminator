"""Capture example API payloads into ``dashboard/fixtures/``.

The fixtures are what the frontend phase develops against, so they must be real
payloads rather than hand-written examples. Two modes:

``--http http://localhost:8000``
    Fetch from a running server. Exercises the whole stack, transport included,
    and is the preferred way to refresh fixtures.

``--asgi``
    Drive the FastAPI app in-process, without binding a socket. Exercises
    routing, request validation, status codes and JSON encoding -- everything
    ``--http`` does except the TCP transport. Useful in CI, or anywhere a
    sandbox forbids listening on a port.

default (direct)
    Call the same functions the routes call, without a web server. Used when
    FastAPI is not installed. Every payload still comes from the real code path;
    only the HTTP transport is bypassed. Each file records which mode produced
    it in ``_captured_via``.

Both modes run real simulations, so this takes a few seconds.

Usage::

    python -m dashboard.tools.capture_fixtures                       # direct
    python -m dashboard.tools.capture_fixtures --asgi
    python -m dashboard.tools.capture_fixtures --http http://localhost:8000
"""

from __future__ import annotations

import argparse
import json
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from dashboard.backend import baseline, packs
from dashboard.backend.runs import RunConflict, RunManager

FIXTURES = packs.DASHBOARD_DIR / "fixtures"
PACK = "power_balance"


def _write(name: str, payload: Any, mode: str, note: str = "") -> None:
    FIXTURES.mkdir(parents=True, exist_ok=True)
    body = payload
    if isinstance(body, dict):
        body = dict(body)
        body["_captured_via"] = mode
        if note:
            body["_note"] = note
    (FIXTURES / f"{name}.json").write_text(
        json.dumps(body, indent=2, sort_keys=False) + "\n", encoding="utf-8"
    )
    print(f"  wrote fixtures/{name}.json")


# ---------------------------------------------------------------------------
# In-process ASGI mode
# ---------------------------------------------------------------------------

def asgi_request(app: Any, method: str, path: str, query: str = "",
                 body: Optional[dict] = None) -> tuple:
    """Send one request straight to an ASGI app and return ``(status, payload)``.

    A minimal ASGI client so the API can be exercised without a listening
    socket: Starlette's own TestClient needs httpx, and some environments
    forbid binding a port at all.
    """
    import asyncio

    encoded = json.dumps(body).encode() if body is not None else b""
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": query.encode(),
        "root_path": "",
        "headers": [(b"host", b"testserver"), (b"content-type", b"application/json"),
                    (b"content-length", str(len(encoded)).encode())],
        "client": ("127.0.0.1", 50000),
        "server": ("testserver", 80),
    }

    messages: list = []
    delivered = False

    async def receive() -> dict:
        nonlocal delivered
        if not delivered:
            delivered = True
            return {"type": "http.request", "body": encoded, "more_body": False}
        return {"type": "http.disconnect"}

    async def send(message: dict) -> None:
        messages.append(message)

    asyncio.run(app(scope, receive, send))

    status = next(m["status"] for m in messages if m["type"] == "http.response.start")
    payload = b"".join(m.get("body", b"") for m in messages
                       if m["type"] == "http.response.body")
    if not payload:
        return status, None
    try:
        return status, json.loads(payload)
    except json.JSONDecodeError:
        # Not every route returns JSON: /docs serves HTML, and a static frontend
        # will serve assets once Phase B adds one.
        return status, payload.decode("utf-8", errors="replace")


def run_lifespan(app: Any, event: str) -> None:
    """Run the app's startup or shutdown lifespan event."""
    import asyncio

    async def drive() -> None:
        received = [{"type": f"lifespan.{event}"}]
        done: list = []

        async def receive() -> dict:
            return received.pop(0) if received else {"type": "lifespan.shutdown"}

        async def send(message: dict) -> None:
            done.append(message)

        await app({"type": "lifespan", "asgi": {"version": "3.0"}}, receive, send)

    try:
        asyncio.run(drive())
    except Exception:  # noqa: BLE001 - lifespan is best-effort in this harness
        pass


def _asgi() -> Callable[..., Any]:
    from dashboard.backend.app import app

    def call(method: str, path: str, body: Optional[dict] = None) -> Any:
        target, _, query = path.partition("?")
        status, payload = asgi_request(app, method, target, query, body)
        if status >= 400:
            return {"_status": status, **(payload or {})}
        return payload

    return call


# ---------------------------------------------------------------------------
# HTTP mode
# ---------------------------------------------------------------------------

def _http(base: str) -> Callable[..., Any]:
    def call(method: str, path: str, body: Optional[dict] = None) -> Any:
        request = urllib.request.Request(
            base.rstrip("/") + path,
            method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Content-Type": "application/json"} if body is not None else {},
        )
        try:
            with urllib.request.urlopen(request) as response:
                return json.loads(response.read().decode())
        except urllib.error.HTTPError as exc:
            return {"_status": exc.code, **json.loads(exc.read().decode() or "{}")}

    return call


def capture_via_call(call: Callable[..., Any], mode: str, label: str) -> None:
    """Capture every fixture through ``call`` (HTTP or in-process ASGI)."""
    print(f"capturing via {label}")

    _write("health", call("GET", "/api/health"), mode)
    _write("packs", call("GET", "/api/packs"), mode)
    _write("pack_power_balance", call("GET", f"/api/packs/{PACK}"), mode)
    for case in ("res", "res_battery"):
        _write(f"topology_{case}", call("GET", f"/api/packs/{PACK}/cases/{case}/topology"), mode)
    _write("baseline_base",
           call("GET", f"/api/packs/{PACK}/cases/base/baseline?day=2012-06-01&houses=5"), mode)

    created = call("POST", "/api/runs", {"pack": PACK, "case": "res_battery",
                                         "day": "2012-06-01", "states": {"soc_start": 90}})
    run_id = created["id"]
    _write("run_created", created, mode, "immediately after POST /api/runs")

    running_snapshot = None
    partial_results = None
    for _ in range(2000):
        status = call("GET", f"/api/runs/{run_id}")
        if status["state"] == "running" and status["rows"] > 0 and running_snapshot is None:
            running_snapshot = status
            partial_results = call("GET", f"/api/runs/{run_id}/results?since=0&limit=3")
        if status["state"] not in ("queued", "running"):
            _write("run_done", status, mode)
            break
        time.sleep(0.02)
    if running_snapshot:
        _write("run_running", running_snapshot, mode, "mid-run snapshot")
    if partial_results:
        _write("results_partial", partial_results, mode, "first 3 rows, fetched mid-run")

    _write("results_full", call("GET", f"/api/runs/{run_id}/results"), mode)
    _write("results_since", call("GET", f"/api/runs/{run_id}/results?since=90"), mode,
           "incremental page: pass the previous response's `next` as `since`")
    _write("summary", call("GET", f"/api/runs/{run_id}/summary"), mode)
    _write("ranges", call("GET", f"/api/runs/{run_id}/ranges"), mode)
    _write("runs_list", call("GET", "/api/runs"), mode)

    # A run that gets cancelled, so the frontend has that state to render, and
    # the 409 a second concurrent request receives while it is still active.
    first = call("POST", "/api/runs", {"pack": PACK, "case": "res", "day": "2012-06-02"})
    conflict = call("POST", "/api/runs", {"pack": PACK, "case": "res", "day": "2012-06-03"})
    _write("run_cancelled", call("DELETE", f"/api/runs/{first['id']}"), mode)

    errors = {
        "unknown_pack_404": call("GET", "/api/packs/nope"),
        "unknown_run_404": call("GET", "/api/runs/nope"),
        "bad_day_400": call("POST", "/api/runs", {"pack": PACK, "case": "res", "day": "2011-01-01"}),
        "dataset_case_400": call("POST", "/api/runs", {"pack": PACK, "case": "base"}),
        "conflict_409": conflict,
    }
    _write("errors", errors, mode, "error response shapes; _status is the HTTP code")


# ---------------------------------------------------------------------------
# Direct mode
# ---------------------------------------------------------------------------

def capture_direct() -> None:
    mode = "direct"
    note = "captured without a web server; payload built by the same function the route calls"
    print("capturing directly (FastAPI not required)")

    manager = RunManager()

    _write("health", {
        "status": "ok" if not packs.check_all_packs() else "degraded",
        "packs": [p["id"] for p in packs.list_packs()],
        "pack_problems": packs.check_all_packs(),
        "repo_root": str(packs.REPO_ROOT),
        "max_concurrent": manager.max_concurrent,
    }, mode, note)

    _write("packs", {"packs": [packs.pack_payload(p) for p in packs.list_packs()]}, mode, note)
    _write("pack_power_balance", packs.pack_payload(packs.load_pack(PACK)), mode, note)

    for case_id in ("res", "res_battery"):
        pack, case = packs.get_case(PACK, case_id)
        _write(f"topology_{case_id}", packs.build_topology(pack, case), mode, note)

    pack, case = packs.get_case(PACK, "base")
    settings, notes = packs.resolve_settings(case, {"houses": 5})
    profile = baseline.profile(pack, case, "2012-06-01", settings)
    profile["notes"] = notes
    _write("baseline_base", profile, mode, note)

    # A real run, polled tightly so a mid-run snapshot can be captured.
    for existing in manager.active_runs():
        manager.cancel(existing.id)
    created = manager.create(PACK, "res_battery", day="2012-06-01", states={"soc_start": 90})
    run_id = created["id"]
    _write("run_created", created, mode, note)

    running_snapshot = None
    partial_results = None
    for _ in range(4000):
        status = manager.get(run_id).status()
        if status["state"] == "running" and status["rows"] > 0 and running_snapshot is None:
            running_snapshot = status
            partial_results = manager.results(run_id, since=0, limit=3)
        if status["state"] not in ("queued", "running"):
            _write("run_done", status, mode, note)
            break
        time.sleep(0.02)

    if running_snapshot:
        _write("run_running", running_snapshot, mode, "mid-run snapshot; " + note)
    if partial_results:
        _write("results_partial", partial_results, mode,
               "first 3 rows, fetched mid-run; " + note)

    _write("results_full", manager.results(run_id), mode, note)
    _write("results_since", manager.results(run_id, since=90), mode,
           "incremental page: pass the previous response's `next` as `since`; " + note)
    _write("summary", manager.summary(run_id), mode, note)
    _write("ranges", manager.ranges(run_id), mode, note)

    # A cancelled run, so the frontend has that state to render too.
    cancelled = manager.create(PACK, "res", day="2012-06-02")
    time.sleep(0.2)
    _write("run_cancelled", manager.cancel(cancelled["id"]), mode, note)

    _write("runs_list", {"runs": manager.list()}, mode, note)

    errors = {
        "unknown_pack_404": {"_status": 404, "detail": _capture_error(packs.load_pack, "nope")},
        "unknown_run_404": {"_status": 404, "detail": _capture_error(manager.get, "nope")},
        "bad_day_400": {"_status": 400,
                        "detail": _capture_error(manager.create, PACK, "res", "2011-01-01")},
        "dataset_case_400": {"_status": 400,
                             "detail": _capture_error(manager.create, PACK, "base")},
        "conflict_409": {"_status": 409, "detail": _conflict_detail(manager)},
    }
    _write("errors", errors, mode, "error response shapes; _status is the HTTP code; " + note)


def _capture_error(func: Callable, *args: Any) -> str:
    try:
        func(*args)
    except KeyError as exc:  # unwrapped exactly as app._detail does
        return str(exc.args[0]) if exc.args else str(exc)
    except Exception as exc:  # noqa: BLE001 - the message is the payload
        return str(exc)
    return ""


def _conflict_detail(manager: RunManager) -> str:
    first = manager.create(PACK, "res", day="2012-06-02")
    try:
        manager.create(PACK, "res", day="2012-06-03")
        return ""
    except RunConflict as exc:
        return str(exc)
    finally:
        manager.cancel(first["id"])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--http", metavar="BASE_URL",
                        help="capture from a running server")
    parser.add_argument("--asgi", action="store_true",
                        help="capture through the FastAPI app in-process (no socket)")
    args = parser.parse_args()
    if args.http:
        capture_via_call(_http(args.http), "http", args.http)
    elif args.asgi:
        from dashboard.backend.app import app as _app
        run_lifespan(_app, "startup")
        try:
            capture_via_call(_asgi(), "asgi", "in-process ASGI")
        finally:
            run_lifespan(_app, "shutdown")
    else:
        capture_direct()
    print(f"fixtures in {FIXTURES}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
