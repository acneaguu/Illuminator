"""FastAPI application for the Illuminator dashboard.

Serves the pack catalogue, derived topologies, dataset profiles and the run
lifecycle. The frontend (added in a later phase) is mounted as static files when
``dashboard/frontend/`` exists, so a single origin serves everything and the
page works offline.

Run it from the repository root::

    uvicorn dashboard.backend.app:app --port 8000
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any, Dict, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import baseline, packs
from .runs import RunConflict, RunError, RunManager

manager = RunManager()


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    # Never leave a simulation (or the Mosaik children it spawned) running after
    # the server stops.
    manager.shutdown()


app = FastAPI(
    title="Illuminator Dashboard API",
    version="0.1.0",
    description="Interface layer over illuminator.engine.Simulation.",
    lifespan=lifespan,
)

# Permissive by design: this is a single-user tool bound to localhost or a
# kiosk, and it keeps a separately served frontend usable during development.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _detail(exc: Exception) -> str:
    """Readable message for an exception.

    ``str(KeyError("x"))`` is the repr, quotes included, which would surface to
    the UI as a doubly quoted string. Unwrap it.
    """
    if isinstance(exc, KeyError) and exc.args:
        return str(exc.args[0])
    return str(exc)


class RunRequest(BaseModel):
    pack: str
    case: str
    day: Optional[str] = None
    settings: Optional[Dict[str, Any]] = None
    states: Optional[Dict[str, Any]] = None


@app.get("/api/health")
def health() -> Dict[str, Any]:
    problems = packs.check_all_packs()
    return {
        "status": "ok" if not problems else "degraded",
        "packs": [p["id"] for p in packs.list_packs()],
        "pack_problems": problems,
        "repo_root": str(packs.REPO_ROOT),
        "max_concurrent": manager.max_concurrent,
    }


@app.get("/api/packs")
def get_packs() -> Dict[str, Any]:
    return {"packs": [packs.pack_payload(p) for p in packs.list_packs()]}


@app.get("/api/packs/{pack_id}")
def get_pack(pack_id: str) -> Dict[str, Any]:
    try:
        return packs.pack_payload(packs.load_pack(pack_id))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=_detail(exc)) from exc


@app.get("/api/packs/{pack_id}/cases/{case_id}/topology")
def get_topology(pack_id: str, case_id: str) -> Dict[str, Any]:
    try:
        pack, case = packs.get_case(pack_id, case_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=_detail(exc)) from exc
    try:
        return packs.build_topology(pack, case)
    except packs.PackError as exc:
        raise HTTPException(status_code=500, detail=_detail(exc)) from exc


@app.get("/api/packs/{pack_id}/cases/{case_id}/baseline")
def get_baseline(pack_id: str, case_id: str,
                 day: Optional[str] = None,
                 houses: Optional[float] = Query(default=None)) -> Dict[str, Any]:
    """Profile for a dataset case -- computed directly from the data file."""
    try:
        pack, case = packs.get_case(pack_id, case_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=_detail(exc)) from exc
    if case["kind"] != "dataset":
        raise HTTPException(status_code=400,
                            detail=f"case '{case_id}' is a simulation, not a dataset view")
    try:
        resolved_day = packs.validate_day(case, day)
        requested = {"houses": houses} if houses is not None else {}
        settings, notes = packs.resolve_settings(case, requested)
        payload = baseline.profile(pack, case, resolved_day, settings)
    except (ValueError, KeyError) as exc:
        raise HTTPException(status_code=400, detail=_detail(exc)) from exc
    payload["notes"] = notes
    return payload


@app.get("/api/runs")
def list_runs() -> Dict[str, Any]:
    return {"runs": manager.list()}


@app.post("/api/runs", status_code=201)
def create_run(request: RunRequest) -> Dict[str, Any]:
    try:
        return manager.create(request.pack, request.case, request.day,
                              request.settings, request.states)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=_detail(exc)) from exc
    except RunConflict as exc:
        raise HTTPException(status_code=409, detail=_detail(exc)) from exc
    except (RunError, ValueError, packs.PackError) as exc:
        raise HTTPException(status_code=400, detail=_detail(exc)) from exc


@app.get("/api/runs/{run_id}")
def get_run(run_id: str) -> Dict[str, Any]:
    try:
        return manager.get(run_id).status()
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=_detail(exc)) from exc


@app.get("/api/runs/{run_id}/results")
def get_results(run_id: str, since: int = 0,
                limit: Optional[int] = None) -> Dict[str, Any]:
    """Result rows from ``since`` onwards. Safe to poll while a run is active."""
    try:
        return manager.results(run_id, since=max(0, since), limit=limit)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=_detail(exc)) from exc


@app.get("/api/runs/{run_id}/summary")
def get_summary(run_id: str) -> Dict[str, Any]:
    try:
        return manager.summary(run_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=_detail(exc)) from exc


@app.get("/api/runs/{run_id}/ranges")
def get_ranges(run_id: str) -> Dict[str, Any]:
    try:
        return manager.ranges(run_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=_detail(exc)) from exc


@app.get("/api/runs/{run_id}/log")
def get_log(run_id: str, tail: int = 100) -> Dict[str, Any]:
    try:
        return manager.log(run_id, tail=tail)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=_detail(exc)) from exc


@app.delete("/api/runs/{run_id}")
def cancel_run(run_id: str) -> Dict[str, Any]:
    try:
        return manager.cancel(run_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=_detail(exc)) from exc


@app.exception_handler(packs.PackError)
def pack_error_handler(request, exc: packs.PackError) -> JSONResponse:
    return JSONResponse(status_code=500, content={"detail": str(exc)})


# Captured API payloads, used by the frontend's mock mode (`?mock=1`) so the UI
# can be demonstrated without running the engine. Mounted before the catch-all.
_FIXTURES = packs.DASHBOARD_DIR / "fixtures"
if _FIXTURES.is_dir():
    app.mount("/fixtures", StaticFiles(directory=str(_FIXTURES)), name="fixtures")

# Mounted last so every route above takes precedence. StaticFiles at "/" would
# otherwise swallow the API paths.
_FRONTEND = packs.DASHBOARD_DIR / "frontend"
if _FRONTEND.is_dir():
    app.mount("/", StaticFiles(directory=str(_FRONTEND), html=True), name="frontend")
