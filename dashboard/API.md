# Dashboard API

The contract between the backend (Phase A) and the frontend (Phase B). Every
payload shown here is abridged from a real capture in `fixtures/` — regenerate
them with:

```shell
# from the repository root, in the conda `illuminator` environment
python -m dashboard.tools.capture_fixtures --http http://localhost:8000   # running server
python -m dashboard.tools.capture_fixtures --asgi                         # in-process, no socket
```

The fixtures in `fixtures/` were captured with `--asgi`
(`_captured_via: "asgi"`): the request goes through the real FastAPI application
-- routing, path and query parsing, pydantic validation, status codes, JSON
encoding -- without binding a socket. Only uvicorn's wire handling is bypassed.

All responses are JSON. `_captured_via` and `_note` appear only in fixture files,
never in live responses.

## Routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness plus pack-consistency report |
| GET | `/api/packs` | All packs, with their cases and controls |
| GET | `/api/packs/{pack}` | One pack |
| GET | `/api/packs/{pack}/cases/{case}/topology` | Display graph for a case |
| GET | `/api/packs/{pack}/cases/{case}/baseline` | Profile for a dataset case (no simulation) |
| GET | `/api/runs` | Run history, newest first |
| POST | `/api/runs` | Start a simulation (201) |
| GET | `/api/runs/{id}` | Run status and progress |
| GET | `/api/runs/{id}/results` | Result rows, incrementally |
| GET | `/api/runs/{id}/summary` | Hourly summary table |
| GET | `/api/runs/{id}/ranges` | Per-column min/max over the run |
| GET | `/api/runs/{id}/log` | Tail of the engine's output |
| DELETE | `/api/runs/{id}` | Cancel a run |

---

## Packs and cases

### `GET /api/packs` → `fixtures/packs.json`

A pack is one tutorial; a case is one task within it. `kind` is `"simulation"`
(runs the engine) or `"dataset"` (read straight from a data file — use the
baseline route, not `POST /api/runs`).

```jsonc
{
  "packs": [{
    "id": "power_balance",
    "title": "Power Balancing for a Local Community",
    "subtitle": "How much of a neighbourhood's demand can local wind and solar cover?",
    "cases": [{
      "id": "res_battery",
      "title": "With renewables and a battery",
      "description": "A communal battery stores surplus local generation ...",
      "kind": "simulation",
      "scenario": "examples/Tutorial1/Tutorial_Power_Balance_b.yaml",
      // Heading over the settings panel. Defaults to "Settings"; a pack may
      // give a case its own word ("Neighbourhood" on a demand-only view).
      "controls_heading": "Settings",
      "day": {
        "default": "2012-06-01", "min": "2012-01-01", "max": "2012-12-30",
        "presets": {"Summer": "2012-06-01", "Winter": "2012-02-01"}
      },
      "controls": [{
        "id": "battery_power",
        "label": "Battery power limit",
        "unit": "kW",
        "type": "slider",           // "slider" | "toggle"
        "min": 0.1, "max": 5, "step": 0.1, "default": 0.8,
        // One control may drive several scenario parameters, so related values
        // cannot drift apart. Informational for the UI; the server applies them.
        "targets": [
          {"model": "Battery1", "param": "max_p",  "scale": 1.0},
          {"model": "Battery1", "param": "min_p",  "scale": -1.0},
          {"model": "Controller1", "param": "max_p", "scale": 1.0}
        ]
      }],
      "states": [{                  // initial model state, not a parameter
        "id": "soc_start", "label": "Battery charge at start of day", "unit": "%",
        "type": "slider", "min": 0, "max": 100, "step": 5, "default": 90,
        "model": "Battery1", "state": "soc"
      }],
      "charts": [...],              // see "Charts" below
      "monitor_items": ["Controller1.flow2b", "Battery1.soc", "..."],
      "summary": {"sum_columns": {...}, "sample_columns": {...}},
      "defaults": {"day": "2012-06-01", "settings": {...}, "states": {...}}
    }]
  }]
}
```

**Rendering controls:** iterate `controls` in order; each is a labelled slider
(`min`/`max`/`step`/`default`, optional `unit`) or a toggle. Send values back
keyed by `id`. `states` render identically but are sent in a separate object.

**Charts** describe what to plot from the result columns:

```jsonc
{
  "id": "battery_soc",
  "title": "Battery state of charge",
  "kind": "line",                       // "line" | "line_with_bands" (Tutorial 3)
  "y_label": "State of charge (%)",
  "y_min": 0, "y_max": 100,
  "limits_from": {"min": "soc_min", "max": "soc_max"},  // draw control values as limit lines
  "series": [{"col": "Battery1.soc", "label": "State of charge", "sign": 1}]
}
```

`sign: -1` on a series means plot the negated column (the tutorials show
`-Controller1.dump` as "power from grid").

### `GET /api/packs/{pack}/cases/{case}/topology` → `fixtures/topology_res_battery.json`

Derived from the scenario YAML (models → nodes, connections → edges) and
decorated by the pack. CSV readers and the Collector are hidden by default.

```jsonc
{
  "pack": "power_balance", "case": "res_battery", "kind": "simulation",
  "nodes": [{
    "id": "Battery1",
    "type": "Battery",          // Illuminator model type
    "category": "battery",      // icon key: pv|wind|load|load_ev|load_hp|battery|grid|controller|generic
    "label": "Battery1",
    "position": [340, 370]      // [x, y]; auto-laid-out when the pack pins none
  }, {
    "id": "Grid",
    "type": "GridConnection", "category": "grid", "label": "National grid",
    "position": [340, -30],
    "virtual": true             // from the pack's extra_nodes, not the scenario
  }],
  "edges": [{
    "from": "Controller1", "to": "Battery1",
    "attrs": [{"from": "flow2b", "to": "flow2b"}],
    "time_shifted": true,            // engine breaks an algebraic loop here
    "column": "Battery1.p_out",      // result column to animate, or null
    "sign": 1.0                      // multiply the column before using it
  }],
  "badges": [
    {"node": "Battery1", "col": "Battery1.soc", "fmt": "{:.0f}%", "bar": true},
    {"node": "Grid", "col": "Controller1.dump", "fmt": "{:.2f} kW", "abs": true}
  ],
  "monitor_items": [...]
}
```

Edges with `"column": null` carry no plotted quantity — draw them static.
`sign` flips the arrow direction for a column whose convention is reversed.

A node or edge marked `"virtual": true` has no counterpart in the scenario. A
pack declares such nodes under `topology.extra_nodes` (id, label, type and a
required `position`), and a `flows:` entry naming one creates the edge as well
as binding it. The national grid is the motivating case: it is where the power
balance closes, but the tutorial models it as a column on the controller
(`Controller1.dump`, positive when exporting) rather than as a model.

On a badge, `"abs": true` asks for the magnitude — the arrow already carries
the direction — and `"bar": true` asks for the value (read as 0–100) to be
drawn as a fill under the node's icon.

### `GET /api/packs/{pack}/cases/{case}/baseline` → `fixtures/baseline_base.json`

Dataset cases only. Answers immediately; no run is involved.

Query: `day=YYYY-MM-DD`, plus **one parameter per control, keyed by control id**
— the same ids `POST /api/runs` takes in `settings`, so a dataset case can
declare whatever controls it likes without an API change
(`?day=2012-06-01&houses=5`). Unknown ids are ignored with a note and
out-of-range values are clamped, exactly as for a run. Which control scales the
profile is the pack's `baseline.scale_by`, not a fixed name.

```jsonc
{
  "kind": "dataset", "day": "2012-06-01", "unit": "kW", "label": "Total load",
  "timestamps": ["2012-06-01 00:00:00", "..."],   // 96 points, 15-minute steps
  "total": [0.487261, "..."],
  "layers": [                                      // optional: stacked generation mix
    {"name": "coal", "share": 0.1431, "color": "brown", "values": [...]}
  ],
  "settings": {"houses": 5},
  "notes": []                                      // e.g. "houses: 99 clamped to [1, 50]"
}
```

Layers stack to `total`; draw them as a stackplot under the load curve.

Baseline values are rounded to 6 decimal places to keep the payload small (sub-milliwatt on a kW-scale load). Simulation results from `/results` are *not* rounded.

---

## Runs

### `POST /api/runs` → 201, `fixtures/run_created.json`

```jsonc
{
  "pack": "power_balance",
  "case": "res_battery",
  "day": "2012-06-01",                      // optional, defaults to case default
  "settings": {"houses": 5, "battery_power": 0.8},   // optional; keyed by control id
  "states": {"soc_start": 90}               // optional; keyed by state-control id
}
```

Omitted controls use their defaults. Out-of-range values are **clamped, not
rejected**, and each adjustment is reported in `notes` — show them rather than
silently accepting a different number than the slider said. Unknown keys are
ignored with a note.

### `GET /api/runs/{id}` → `fixtures/run_running.json`, `fixtures/run_done.json`

```jsonc
{
  "id": "20260911-162457-power_balance-res_battery",
  "pack": "power_balance", "case": "res_battery",
  "title": "Power Balancing for a Local Community - With renewables and a battery",
  "day": "2012-06-01",
  "state": "running",          // queued | running | done | error | cancelled
  "progress": 0.0526,          // rows / expected_steps, 1.0 when done
  "rows": 5,
  "expected_steps": 95,        // one CSV row per simulation step
  "created_at": "...", "started_at": "...", "finished_at": null,
  "error": null,               // see below when state == "error"
  "exit_code": null,
  "settings": {...}, "state_values": {...}, "monitor_items": [...],
  "notes": []
}
```

`state` is terminal when it is not `queued` or `running`. On failure:

```jsonc
"error": {
  "type": "KeyError",
  "message": "Parameter 'not_a_real_parameter' not found in model 'Wind1'. Available parameters: p_rated, ...",
  "traceback": "Traceback (most recent call last): ..."
}
```

`type: "ProcessExited"` means the simulation died without reporting anything
(the traceback then holds the tail of `run.log`); `type: "Interrupted"` means the
server restarted mid-run.

### `GET /api/runs/{id}/results?since=N&limit=M` → `fixtures/results_full.json`

Safe to poll while a run is active — the Collector appends one row per step.

```jsonc
{
  "time_column": "date",
  "columns": ["Controller1.flow2b", "Battery1.soc", "..."],
  "rows": [["2012-06-01 00:00:00", 0.0, 90.0, "..."]],   // [timestamp, ...values]
  "since": 0, "next": 95, "total": 95,
  "id": "...", "state": "done", "progress": 1.0,
  "expected_steps": 95,
  "complete": true          // true once the run reached a terminal state
}
```

**Poll by passing the previous response's `next` back as `since`** — verified to
produce no gaps or duplicates across a live run. Each row aligns to
`[time_column] + columns`.

Two collector quirks the backend already absorbs, but worth knowing:

* **Column order varies between runs** and does not follow `monitor_items`.
  Always look columns up by name. This is not hypothetical: two captures of the
  same scenario produced bit-identical values in a *different* column order.
* The first row's timestamp is date-only in the CSV; the API pads it to a full
  timestamp, so every row is `YYYY-MM-DD HH:MM:SS`.

A one-day run has 95 rows at 15-minute spacing, ending at 23:30 (the 23:45 value
is the next step's input, past the simulated window).

### `GET /api/runs/{id}/summary` → `fixtures/summary.json`

Hourly table, 24 rows. Flow columns are summed over the hour; state columns
(battery SOC) are sampled at the hour boundary instead.

The dashboard does not use this endpoint: it shows a row per simulation step
and computes day totals from the rows it already polled, which keeps both live
during a run and avoids re-rounding. The endpoint remains for scripted use — it
mirrors the tutorials' own `functions_T1.summarize_results`.

```jsonc
{
  "columns": [{"key": "Load1.load_dem", "label": "Load demand (kW)", "agg": "sum"}],
  "rows": [{"hour": "00:00", "date": "2012-06-01", "values": [7.74, 0.0, 1.08]}]
}
```

`values` aligns with `columns`; entries may be `null`.

`agg` says how the column may be reduced to one number for the whole day:
`"sum"` for a flow, `"sample"` for a level such as state of charge, which the
comparison table averages instead — adding up 24 readings of a level would mean
nothing. It mirrors which half of the pack's `summary:` section the column came
from.

### `GET /api/runs/{id}/ranges` → `fixtures/ranges.json`

```jsonc
{"ranges": {"Battery1.soc": {"min": 10.001, "max": 90.0}}}
```

Used to normalise each animated flow against its own range in the topology view.

### `DELETE /api/runs/{id}` → `fixtures/run_cancelled.json`

Terminates the simulation and everything Mosaik started under it, then returns
the run's final status with `state: "cancelled"`.

### `GET /api/runs/{id}/log?tail=100`

`{"id": "...", "log": "..."}` — the engine and Mosaik print a lot; this is for a
diagnostics panel, not the main UI.

---

## Errors → `fixtures/errors.json`

FastAPI's standard shape, `{"detail": "..."}`:

| Status | When |
|---|---|
| 400 | Day outside the data range; `POST /api/runs` for a dataset case; baseline requested for a simulation case |
| 404 | Unknown pack, case or run |
| 409 | A simulation is already running — **only one at a time by default** |
| 422 | Request body fails validation (e.g. `pack` missing). FastAPI's own shape: `detail` is a **list** of field errors, not a string |
| 500 | Pack inconsistent with its scenario YAML |

Note the 422 exception: for every other status `detail` is a plain string, but
pydantic validation errors put a list of per-field objects there. Handle both.

The 409 is expected in normal use: the Simulate button should offer to cancel the
active run. Its `detail` names the run holding the slot.

---

## Notes for the frontend

* **Runs are fast.** A one-day Tutorial 1 scenario completes in roughly 1–2
  seconds on a laptop. Progressive polling still matters (and matters more on a
  Raspberry Pi), but the UI should not assume a long wait.
* Poll `GET /api/runs/{id}` and `GET /api/runs/{id}/results?since=N` together on
  the same tick; stop when `state` is terminal.
* Everything needed to render a case — controls, charts, topology, summary
  labels, the settings heading — comes from the pack. Add a tutorial by adding a
  pack file, not by changing frontend code.
* `/api/packs` returns **every** installed pack, not just one. The dashboard
  shows a switcher in the top bar when there is more than one, and `?pack=<id>`
  deep-links a particular tutorial.
