"""Scenario *pack* loading, validation and topology derivation.

A pack is a YAML file in ``dashboard/packs/`` describing one tutorial: a list of
cases, each pointing at an Illuminator scenario YAML plus the controls, monitor
items, charts and topology overlay the dashboard should present for it.

Nothing in this module imports :mod:`illuminator` -- the server process must stay
free of it (only :mod:`dashboard.backend.runner`, which runs in a subprocess,
imports the engine). Scenario YAMLs are parsed directly with ruamel so we can
derive the topology graph and cross-check that every control actually refers to a
parameter the scenario declares.
"""

from __future__ import annotations

import datetime as _dt
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from ruamel.yaml import YAML

# dashboard/backend/packs.py -> dashboard/backend -> dashboard -> repo root
REPO_ROOT = Path(__file__).resolve().parents[2]
DASHBOARD_DIR = REPO_ROOT / "dashboard"
PACKS_DIR = DASHBOARD_DIR / "packs"
RUNS_DIR = DASHBOARD_DIR / "runs"

#: Illuminator model type -> icon / styling category used by the frontend.
TYPE_CATEGORY = {
    "CSV": "data",
    "Collector": "collector",
    "PV": "pv",
    "Wind": "wind",
    "Load": "load",
    "LoadEV": "load_ev",
    "LoadHeatpump": "load_hp",
    "EV": "load_ev",
    "Battery": "battery",
    "GridConnection": "grid",
}

#: Model types starting with any of these map to a category by prefix, so the
#: many per-tutorial controller classes (Controller_T1, ControllerT3Congestion,
#: Controller_T4, ...) all render with the controller icon.
CATEGORY_PREFIXES = (("Controller", "controller"),)


def category_for(model_type: Optional[str]) -> str:
    """Icon / styling category for an Illuminator model type."""
    if not model_type:
        return "generic"
    if model_type in TYPE_CATEGORY:
        return TYPE_CATEGORY[model_type]
    for prefix, category in CATEGORY_PREFIXES:
        if model_type.startswith(prefix):
            return category
    return "generic"

DEFAULT_TIME_RESOLUTION = 900


class PackError(Exception):
    """Raised when a pack file is malformed or inconsistent with its scenario."""


def _yaml() -> YAML:
    return YAML(typ="safe")


def _load_yaml(path: Path) -> dict:
    with open(path, "r", encoding="utf-8") as handle:
        return _yaml().load(handle)


# ---------------------------------------------------------------------------
# Scenario YAML introspection
# ---------------------------------------------------------------------------

class Scenario:
    """A parsed Illuminator scenario YAML, queried for declared attributes.

    Only reads the file -- it is never written back. Used both to validate packs
    and to derive the topology graph.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self.raw = _load_yaml(path)
        if not isinstance(self.raw, dict) or "models" not in self.raw:
            raise PackError(f"{path} does not look like an Illuminator scenario")
        self.models: Dict[str, dict] = {m["name"]: m for m in self.raw.get("models", [])}
        self.connections: List[dict] = list(self.raw.get("connections", []) or [])

    @property
    def time_resolution(self) -> int:
        return int(self.raw.get("scenario", {}).get("time_resolution", DEFAULT_TIME_RESOLUTION))

    def model_type(self, name: str) -> Optional[str]:
        model = self.models.get(name)
        return model.get("type") if model else None

    def declares_parameter(self, model: str, param: str) -> bool:
        entry = self.models.get(model)
        return bool(entry) and param in (entry.get("parameters") or {})

    def declares_state(self, model: str, state: str) -> bool:
        entry = self.models.get(model)
        return bool(entry) and state in (entry.get("states") or {})

    def declares_attribute(self, model: str, attr: str) -> bool:
        """True if ``attr`` is an input, output or state of ``model``.

        Monitor items must name a declared attribute. CSV readers are the
        exception: they register their columns as states at runtime, so any
        attribute on a CSV model is accepted.
        """
        entry = self.models.get(model)
        if not entry:
            return False
        if entry.get("type") == "CSV":
            return True
        for section in ("inputs", "outputs", "states"):
            if attr in (entry.get(section) or {}):
                return True
        return False

    def parameter_default(self, model: str, param: str) -> Any:
        return (self.models.get(model, {}).get("parameters") or {}).get(param)


# ---------------------------------------------------------------------------
# Pack loading
# ---------------------------------------------------------------------------

_PACK_CACHE: Dict[str, dict] = {}


def _normalise_control(raw: dict, index: int) -> dict:
    """Expand a control definition into a canonical form.

    A control writes one slider/toggle value into one or more scenario
    parameters. ``targets`` lets a single control keep related parameters in
    sync (e.g. a battery power limit writes ``Battery1.max_p``,
    ``Battery1.min_p`` negated, and ``Controller1.max_p``), with an optional
    per-target ``scale``.
    """
    control = dict(raw)
    if "targets" in control:
        # An explicitly empty list is valid: dataset-case controls (e.g. the
        # number of houses on the demand-only view) scale a data profile and
        # have no scenario parameter to write.
        targets = control["targets"] or []
    else:
        model, param = control.get("model"), control.get("param")
        if not model or not param:
            raise PackError(f"control #{index} needs either 'targets' or 'model'+'param'")
        targets = [{"model": model, "param": param}]
    normalised = []
    for target in targets:
        if "model" not in target or "param" not in target:
            raise PackError(f"control '{control.get('id')}' has a target without model/param")
        normalised.append({
            "model": target["model"],
            "param": target["param"],
            "scale": float(target.get("scale", 1.0)),
        })
    control["targets"] = normalised
    if normalised:
        control.setdefault("id", normalised[0]["param"])
    elif "id" not in control:
        raise PackError(f"control #{index} has no targets and no explicit 'id'")
    control.setdefault("type", "slider")
    control.setdefault("label", control["id"])
    if control["type"] == "slider":
        for key in ("min", "max", "step", "default"):
            if key not in control:
                raise PackError(f"slider control '{control['id']}' is missing '{key}'")
    elif control["type"] == "toggle":
        control.setdefault("default", False)
    else:
        raise PackError(f"control '{control['id']}' has unsupported type {control['type']!r}")
    control.pop("model", None)
    control.pop("param", None)
    return control


def _normalise_state(raw: dict, index: int) -> dict:
    state = dict(raw)
    for key in ("model", "state"):
        if key not in state:
            raise PackError(f"state control #{index} is missing '{key}'")
    state.setdefault("id", f"{state['model']}.{state['state']}")
    state.setdefault("type", "slider")
    state.setdefault("label", state["id"])
    if state["type"] == "slider":
        for key in ("min", "max", "step", "default"):
            if key not in state:
                raise PackError(f"state slider '{state['id']}' is missing '{key}'")
    return state


def _normalise_case(pack: dict, raw: dict, index: int) -> dict:
    case = dict(raw)
    if "id" not in case:
        raise PackError(f"case #{index} in pack '{pack['id']}' has no id")
    case.setdefault("title", case["id"])
    kind = case.setdefault("kind", "simulation")
    if kind not in ("simulation", "dataset"):
        raise PackError(f"case '{case['id']}' has unsupported kind {kind!r}")
    case["controls"] = [_normalise_control(c, i) for i, c in enumerate(case.get("controls") or [])]
    case["states"] = [_normalise_state(s, i) for i, s in enumerate(case.get("states") or [])]
    case["monitor_items"] = list(case.get("monitor_items") or [])
    case["charts"] = list(case.get("charts") or [])
    case["csv_overrides"] = dict(case.get("csv_overrides") or {})
    case.setdefault("topology", {})
    case.setdefault("summary", {})

    day = dict(case.get("day") or {})
    day.setdefault("default", pack.get("day", {}).get("default"))
    day.setdefault("min", pack.get("day", {}).get("min"))
    day.setdefault("max", pack.get("day", {}).get("max"))
    day.setdefault("presets", pack.get("day", {}).get("presets") or {})
    if not day["default"]:
        raise PackError(f"case '{case['id']}' has no default day (set case.day or pack.day)")
    case["day"] = day

    if kind == "simulation" and not case.get("scenario"):
        raise PackError(f"simulation case '{case['id']}' has no 'scenario' path")
    if kind == "dataset" and not case.get("baseline"):
        raise PackError(f"dataset case '{case['id']}' has no 'baseline' block")
    return case


def load_pack(pack_id: str, *, refresh: bool = False) -> dict:
    """Load and normalise one pack by id."""
    if not refresh and pack_id in _PACK_CACHE:
        return _PACK_CACHE[pack_id]
    path = PACKS_DIR / f"{pack_id}.yaml"
    if not path.exists():
        raise KeyError(f"no such pack: {pack_id}")
    raw = _load_yaml(path)
    pack = dict(raw)
    pack.setdefault("id", pack_id)
    if pack["id"] != pack_id:
        raise PackError(f"pack file {path.name} declares id {pack['id']!r}")
    pack.setdefault("title", pack_id)
    pack["cases"] = [_normalise_case(pack, c, i) for i, c in enumerate(pack.get("cases") or [])]
    if not pack["cases"]:
        raise PackError(f"pack '{pack_id}' has no cases")
    _PACK_CACHE[pack_id] = pack
    return pack


def list_packs(*, refresh: bool = False) -> List[dict]:
    """All packs found in ``dashboard/packs/``, ordered by filename."""
    return [load_pack(p.stem, refresh=refresh) for p in sorted(PACKS_DIR.glob("*.yaml"))]


def get_case(pack_id: str, case_id: str) -> Tuple[dict, dict]:
    pack = load_pack(pack_id)
    for case in pack["cases"]:
        if case["id"] == case_id:
            return pack, case
    raise KeyError(f"no such case: {pack_id}/{case_id}")


def scenario_for(case: dict) -> Scenario:
    return Scenario(REPO_ROOT / case["scenario"])


# ---------------------------------------------------------------------------
# Paths, settings and the run spec
# ---------------------------------------------------------------------------

def data_dir_for(pack: dict) -> Path:
    return REPO_ROOT / pack["data_dir"]


def resolve_csv_overrides(pack: dict, case: dict) -> Dict[str, str]:
    """Map CSV model name -> absolute data file path.

    Always applied: several committed tutorial YAMLs point at paths that no
    longer exist (e.g. ``Tutorial1/Tutorial1/load_data.txt``), and the notebooks
    override them too.
    """
    base = data_dir_for(pack)
    resolved = {}
    for model, filename in case["csv_overrides"].items():
        path = (base / filename).resolve()
        if not path.exists():
            raise PackError(f"data file for {model} not found: {path}")
        resolved[model] = str(path)
    return resolved


def control_defaults(case: dict) -> Dict[str, Any]:
    return {c["id"]: c["default"] for c in case["controls"]}


def state_defaults(case: dict) -> Dict[str, Any]:
    return {s["id"]: s["default"] for s in case["states"]}


def _clamp(control: dict, value: Any) -> Tuple[Any, Optional[str]]:
    if control["type"] == "toggle":
        return bool(value), None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return control["default"], (
            f"{control['id']}: {value!r} is not a number, using default {control['default']}"
        )
    low, high = float(control["min"]), float(control["max"])
    if number < low or number > high:
        clamped = min(max(number, low), high)
        return clamped, f"{control['id']}: {number} clamped to [{low}, {high}]"
    return number, None


def resolve_settings(case: dict, requested: Optional[Dict[str, Any]]) -> Tuple[Dict[str, Any], List[str]]:
    """Merge requested control values over the defaults, clamping to range."""
    requested = requested or {}
    known = {c["id"]: c for c in case["controls"]}
    notes = [f"unknown control '{key}' ignored" for key in requested if key not in known]
    values: Dict[str, Any] = {}
    for control_id, control in known.items():
        if control_id in requested:
            value, note = _clamp(control, requested[control_id])
            if note:
                notes.append(note)
        else:
            value = control["default"]
        values[control_id] = value
    return values, notes


def resolve_states(case: dict, requested: Optional[Dict[str, Any]]) -> Tuple[Dict[str, Any], List[str]]:
    requested = requested or {}
    known = {s["id"]: s for s in case["states"]}
    notes = [f"unknown state '{key}' ignored" for key in requested if key not in known]
    values: Dict[str, Any] = {}
    for state_id, state in known.items():
        if state_id in requested:
            value, note = _clamp(state, requested[state_id])
            if note:
                notes.append(note)
        else:
            value = state["default"]
        values[state_id] = value
    return values, notes


def build_new_settings(case: dict, values: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    """Turn resolved control values into the engine's ``new_settings`` dict.

    Shape matches what the notebooks pass to ``Simulation.edit_models``:
    ``{model_name: {parameter: value}}``.
    """
    new_settings: Dict[str, Dict[str, Any]] = {}
    for control in case["controls"]:
        value = values[control["id"]]
        for target in control["targets"]:
            if control["type"] == "toggle":
                resolved = bool(value)
            else:
                resolved = float(value) * target["scale"]
                if float(resolved).is_integer() and _is_integral_control(control):
                    resolved = int(resolved)
            new_settings.setdefault(target["model"], {})[target["param"]] = resolved
    return new_settings


def _is_integral_control(control: dict) -> bool:
    if control["type"] != "slider":
        return False
    return (float(control.get("step", 1)).is_integer()
            and float(control["default"]).is_integer())


def build_state_updates(case: dict, values: Dict[str, Any]) -> List[Dict[str, Any]]:
    """``[{model, state, value}]`` for ``Simulation.set_model_state`` calls."""
    updates = []
    for state in case["states"]:
        updates.append({
            "model": state["model"],
            "state": state["state"],
            "value": values[state["id"]],
        })
    return updates


def validate_day(case: dict, day: Optional[str]) -> str:
    """Check a ``YYYY-MM-DD`` day against the case's allowed range."""
    day = day or case["day"]["default"]
    try:
        parsed = _dt.date.fromisoformat(day)
    except ValueError as exc:
        raise ValueError(f"day must be YYYY-MM-DD, got {day!r}") from exc
    for bound, comparator, label in (
        (case["day"].get("min"), lambda a, b: a < b, "before"),
        (case["day"].get("max"), lambda a, b: a > b, "after"),
    ):
        if bound and comparator(parsed, _dt.date.fromisoformat(bound)):
            raise ValueError(
                f"day {day} is {label} the data available for this case "
                f"({case['day'].get('min')} .. {case['day'].get('max')})"
            )
    return parsed.isoformat()


def day_window(day: str) -> Tuple[str, str]:
    """The scenario start/end timestamps for a single day, as the notebooks use."""
    return f"{day} 00:00:00", f"{day} 23:45:00"


def expected_steps(start_time: str, end_time: str, time_resolution: int) -> int:
    """Mosaik step count for a run.

    Mirrors ``illuminator.engine.compute_mosaik_end_time`` (floor of the duration
    over the resolution) without importing the engine, because the server process
    must stay free of it. The collector writes one CSV row per step.
    """
    fmt = "%Y-%m-%d %H:%M:%S"
    start = _dt.datetime.strptime(start_time, fmt)
    end = _dt.datetime.strptime(end_time, fmt)
    return int((end - start).total_seconds() // time_resolution)


def build_spec(pack: dict, case: dict, day: str, settings: Dict[str, Any],
               states: Dict[str, Any], out_file: Path) -> dict:
    """The full, self-contained description of one simulation run.

    Written to ``spec.json`` and consumed by the runner subprocess, so a run can
    be reproduced (or debugged) from its directory alone.
    """
    scenario = scenario_for(case)
    start_time, end_time = day_window(day)
    return {
        "pack": pack["id"],
        "case": case["id"],
        "title": f"{pack['title']} - {case['title']}",
        "day": day,
        "scenario": str((REPO_ROOT / case["scenario"]).resolve()),
        "csv_overrides": resolve_csv_overrides(pack, case),
        "new_settings": build_new_settings(case, settings),
        "states": build_state_updates(case, states),
        "start_time": start_time,
        "end_time": end_time,
        "time_resolution": scenario.time_resolution,
        "expected_steps": expected_steps(start_time, end_time, scenario.time_resolution),
        "monitor_items": case["monitor_items"],
        "out_file": str(out_file),
        "settings": settings,
        "state_values": states,
    }


# ---------------------------------------------------------------------------
# Topology derivation
# ---------------------------------------------------------------------------

def _auto_layout(node_ids: List[str], edges: List[dict]) -> Dict[str, List[int]]:
    """Column layout for nodes the pack gives no explicit position.

    Sources go left, sinks right: a node's column is one past its deepest
    predecessor. Keeps generic scenarios (including ones the dashboard has never
    seen) readable without hand-placed coordinates.
    """
    preds: Dict[str, List[str]] = {n: [] for n in node_ids}
    for edge in edges:
        if edge["to"] in preds and edge["from"] in preds:
            preds[edge["to"]].append(edge["from"])

    column: Dict[str, int] = {}

    def depth(node: str, seen: frozenset) -> int:
        if node in column:
            return column[node]
        if node in seen or not preds[node]:
            return 0
        return 1 + max(depth(p, seen | {node}) for p in preds[node])

    for node in node_ids:
        column[node] = depth(node, frozenset())

    by_column: Dict[int, List[str]] = {}
    for node, col in column.items():
        by_column.setdefault(col, []).append(node)

    positions = {}
    x_step, y_step, y0 = 220, 140, 80
    for col, nodes in by_column.items():
        for row, node in enumerate(sorted(nodes)):
            positions[node] = [80 + col * x_step, y0 + row * y_step]
    return positions


def build_topology(pack: dict, case: dict) -> dict:
    """Derive the display graph for a case from its scenario YAML + overlay.

    Nodes come from the scenario's ``models``, edges from its ``connections``;
    the pack's ``topology`` block only *decorates* that (hiding data readers,
    pinning positions, binding edges to result columns). Scenarios with no
    overlay still render, which is the seam for adding models later.
    """
    if case["kind"] != "simulation":
        return {"pack": pack["id"], "case": case["id"], "nodes": [], "edges": [],
                "badges": [], "kind": case["kind"]}

    scenario = scenario_for(case)
    overlay = case["topology"] or {}

    hidden = set(overlay.get("hidden") or [])
    hidden.add("Collector")  # injected by the engine at run time, never displayed
    if not overlay.get("show_data_nodes"):
        hidden.update(n for n, m in scenario.models.items() if m.get("type") == "CSV")

    visible = [name for name in scenario.models if name not in hidden]

    # Collapse per-attribute connections into one edge per model pair.
    edge_index: Dict[Tuple[str, str], dict] = {}
    for connection in scenario.connections:
        try:
            src = connection["from"].split(".")[0]
            dst = connection["to"].split(".")[0]
        except (KeyError, AttributeError):
            continue
        if src in hidden or dst in hidden:
            continue
        key = (src, dst)
        edge = edge_index.setdefault(key, {
            "from": src, "to": dst, "attrs": [],
            "time_shifted": bool(connection.get("time_shifted", False)),
        })
        edge["attrs"].append({
            "from": connection["from"].split(".", 1)[1],
            "to": connection["to"].split(".", 1)[1],
        })
        if connection.get("time_shifted"):
            edge["time_shifted"] = True

    edges = list(edge_index.values())

    positions = dict(overlay.get("positions") or {})
    missing = [n for n in visible if n not in positions]
    if missing:
        positions.update({n: p for n, p in _auto_layout(visible, edges).items() if n in missing})

    nodes = []
    for name in visible:
        model_type = scenario.model_type(name)
        nodes.append({
            "id": name,
            "type": model_type,
            "category": category_for(model_type),
            "label": (overlay.get("labels") or {}).get(name, name),
            "position": positions[name],
        })

    # Nodes the diagram needs that the scenario does not model. The national
    # grid is the obvious one: the tutorials treat it as the endpoint that
    # absorbs or covers whatever the community cannot balance itself, and the
    # controller reports the exchange on a column rather than through a link.
    for extra in overlay.get("extra_nodes") or []:
        model_type = extra.get("type")
        nodes.append({
            "id": extra["id"],
            "type": model_type,
            "category": extra.get("category") or category_for(model_type),
            "label": extra.get("label", extra["id"]),
            "position": list(extra.get("position") or [0, 0]),
            "virtual": True,
        })

    # Bind edges to result columns so the frontend can animate real flows. A
    # flow that names an extra node has no scenario connection behind it, so it
    # creates the edge as well as decorating it.
    known = {node["id"] for node in nodes}
    flows = overlay.get("flows") or []
    for flow in flows:
        source, target = flow.get("from"), flow.get("to")
        edge = next((e for e in edges if e["from"] == source and e["to"] == target), None)
        if edge is None:
            if source not in known or target not in known:
                continue
            edge = {"from": source, "to": target, "attrs": [],
                    "time_shifted": False, "virtual": True}
            edges.append(edge)
        edge["column"] = flow.get("col")
        edge["sign"] = float(flow.get("sign", 1))
        if flow.get("congestion"):
            edge["congestion"] = flow["congestion"]
    for edge in edges:
        edge.setdefault("column", None)
        edge.setdefault("sign", 1.0)

    return {
        "pack": pack["id"],
        "case": case["id"],
        "kind": case["kind"],
        "nodes": nodes,
        "edges": edges,
        "badges": overlay.get("badges") or [],
        "monitor_items": case["monitor_items"],
    }


# ---------------------------------------------------------------------------
# API payload shaping
# ---------------------------------------------------------------------------

def case_payload(case: dict) -> Dict[str, Any]:
    """A case as the frontend needs it: controls, day range, charts, monitoring.

    Lives here rather than in the FastAPI layer so payload shape can be tested
    without a web server.
    """
    return {
        "id": case["id"],
        "title": case["title"],
        "description": (case.get("description") or "").strip(),
        "kind": case["kind"],
        "scenario": case.get("scenario"),
        "day": case["day"],
        "controls": case["controls"],
        "states": case["states"],
        "charts": case["charts"],
        "monitor_items": case["monitor_items"],
        "summary": case.get("summary") or {},
        "defaults": {
            "day": case["day"]["default"],
            "settings": control_defaults(case),
            "states": state_defaults(case),
        },
    }


def pack_payload(pack: dict) -> Dict[str, Any]:
    return {
        "id": pack["id"],
        "title": pack["title"],
        "subtitle": pack.get("subtitle", ""),
        "cases": [case_payload(case) for case in pack["cases"]],
    }


# ---------------------------------------------------------------------------
# Self-check
# ---------------------------------------------------------------------------

def check_pack(pack_id: str) -> List[str]:
    """Cross-check a pack against the scenario YAMLs it references.

    Catches the mistakes that would otherwise only surface as a mid-run
    ``KeyError`` from ``edit_models`` or a schema error from the monitor section.
    Returns a list of problems; empty means the pack is consistent.
    """
    problems: List[str] = []
    try:
        pack = load_pack(pack_id, refresh=True)
    except (PackError, KeyError) as exc:
        return [f"{pack_id}: {exc}"]

    if not (REPO_ROOT / pack["data_dir"]).is_dir():
        problems.append(f"{pack_id}: data_dir does not exist: {pack['data_dir']}")

    for case in pack["cases"]:
        where = f"{pack_id}/{case['id']}"
        if case["kind"] == "dataset":
            baseline_file = data_dir_for(pack) / case["baseline"]["file"]
            if not baseline_file.exists():
                problems.append(f"{where}: baseline file missing: {baseline_file}")
            continue

        scenario_path = REPO_ROOT / case["scenario"]
        if not scenario_path.exists():
            problems.append(f"{where}: scenario missing: {case['scenario']}")
            continue
        try:
            scenario = Scenario(scenario_path)
        except PackError as exc:
            problems.append(f"{where}: {exc}")
            continue

        try:
            resolve_csv_overrides(pack, case)
        except PackError as exc:
            problems.append(f"{where}: {exc}")
        for model in case["csv_overrides"]:
            if model not in scenario.models:
                problems.append(f"{where}: csv_override for unknown model '{model}'")
            elif scenario.model_type(model) != "CSV":
                problems.append(f"{where}: csv_override target '{model}' is not a CSV model")
        for model, entry in scenario.models.items():
            if entry.get("type") == "CSV" and model not in case["csv_overrides"]:
                problems.append(
                    f"{where}: CSV model '{model}' has no csv_override; the committed "
                    "file_path may not exist"
                )

        # edit_models() raises KeyError unless the parameter is declared in the YAML.
        for control in case["controls"]:
            for target in control["targets"]:
                if not scenario.declares_parameter(target["model"], target["param"]):
                    problems.append(
                        f"{where}: control '{control['id']}' targets undeclared parameter "
                        f"{target['model']}.{target['param']}"
                    )
        for state in case["states"]:
            if not scenario.declares_state(state["model"], state["state"]):
                problems.append(
                    f"{where}: state control '{state['id']}' targets undeclared state "
                    f"{state['model']}.{state['state']}"
                )

        seen = set()
        for item in case["monitor_items"]:
            if "." not in item:
                problems.append(f"{where}: monitor item '{item}' must be <model>.<attr>")
                continue
            if item in seen:
                problems.append(f"{where}: duplicate monitor item '{item}'")
            seen.add(item)
            model, attr = item.split(".", 1)
            if not scenario.declares_attribute(model, attr):
                problems.append(
                    f"{where}: monitor item '{item}' is not an input/output/state of '{model}'"
                )

        # Chart and badge bindings must be monitored, or they will never have data.
        for chart in case["charts"]:
            for series in chart.get("series") or []:
                if series.get("col") and series["col"] not in case["monitor_items"]:
                    problems.append(
                        f"{where}: chart '{chart.get('id')}' plots unmonitored column "
                        f"'{series['col']}'"
                    )
        overlay = case["topology"] or {}
        extra_ids = set()
        for extra in overlay.get("extra_nodes") or []:
            if not extra.get("id"):
                problems.append(f"{where}: topology extra_node has no id")
                continue
            extra_ids.add(extra["id"])
            if extra["id"] in scenario.models:
                problems.append(f"{where}: extra_node '{extra['id']}' shadows a scenario model")
            if not extra.get("position"):
                # Auto-layout works off the scenario graph, which knows nothing
                # about a node that is not in it.
                problems.append(f"{where}: extra_node '{extra['id']}' needs a position")
        drawable = set(scenario.models) | extra_ids

        for badge in overlay.get("badges") or []:
            if badge.get("col") and badge["col"] not in case["monitor_items"]:
                problems.append(f"{where}: badge on '{badge.get('node')}' uses unmonitored "
                                f"column '{badge['col']}'")
            if badge.get("node") and badge["node"] not in drawable:
                problems.append(f"{where}: badge refers to unknown node '{badge['node']}'")
        for flow in overlay.get("flows") or []:
            if flow.get("col") and flow["col"] not in case["monitor_items"]:
                problems.append(f"{where}: flow {flow.get('from')}->{flow.get('to')} uses "
                                f"unmonitored column '{flow['col']}'")
            for end in ("from", "to"):
                if flow.get(end) and flow[end] not in drawable:
                    problems.append(f"{where}: flow refers to unknown model '{flow[end]}'")

        for section in ("sum_columns", "sample_columns"):
            for column in (case["summary"].get(section) or {}):
                if column not in case["monitor_items"]:
                    problems.append(
                        f"{where}: summary {section} references unmonitored column '{column}'"
                    )

        for bound in ("min", "max"):
            if case["day"].get(bound):
                try:
                    _dt.date.fromisoformat(case["day"][bound])
                except ValueError:
                    problems.append(f"{where}: day.{bound} is not YYYY-MM-DD")
        try:
            validate_day(case, case["day"]["default"])
        except ValueError as exc:
            problems.append(f"{where}: {exc}")

    return problems


def check_all_packs() -> List[str]:
    problems = []
    for path in sorted(PACKS_DIR.glob("*.yaml")):
        problems.extend(check_pack(path.stem))
    return problems


if __name__ == "__main__":  # pragma: no cover - developer helper
    import sys

    found = check_all_packs()
    for problem in found:
        print(f"PROBLEM  {problem}")
    if not found:
        names = [p["id"] for p in list_packs()]
        print(f"OK: {len(names)} pack(s) consistent with their scenarios: {', '.join(names)}")
    sys.exit(1 if found else 0)
