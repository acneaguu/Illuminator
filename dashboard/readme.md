# Illuminator Dashboard

A touchscreen dashboard for the Illuminator tutorials. It replaces the Jupyter
notebooks with sliders, a Simulate button, charts and an animated view of the
energy system, so the code stays out of the way.

**It is an interface layer only.** It drives the public
`illuminator.engine.Simulation` API exactly the way the notebooks do and does not
modify — or require any modification to — the Illuminator source. Everything
lives under `dashboard/`.

## Status

Phases A–C are complete: the backend runs scenarios and the frontend drives
them, charts the results, compares two runs and animates the energy system.
Phase D is not started.

| Phase | Scope | State |
|---|---|---|
| A | Backend, Tutorial 1 pack, API contract | **done**, verified end to end |
| B | Frontend shell: controls, run button, charts, summary table, run comparison | **done**, verified end to end |
| C | Topology view: icons, animated flows, time scrubber | **done**, verified end to end |
| D | Tutorial 3 pack: grid congestion, band chart, EV/heat-pump nodes | not started |

## Setup

Use the same environment the Illuminator runs in (the conda env `illuminator`,
Python 3.11), then add the two dashboard dependencies:

```shell
# from the repository root
pip install -r dashboard/requirements.txt
```

The dashboard imports the *installed* `illuminator` package. If you want it to
pick up local edits to `src/`, install the repo editable once:

```shell
pip install -e .
```

## Running

```shell
# from the repository root
python dashboard/run_dashboard.py
```

That serves the dashboard and opens a browser at it. `--help` lists the options;
the useful ones are `--demo` (see below), `--port`, `--host 0.0.0.0` to let other
machines connect, and `--reload` while editing code.

In PyCharm, copy the ready-made run configurations into place once:

```shell
cp -r dashboard/ide/pycharm/runConfigurations .idea/
```

and a **Dashboard** group appears in the run selector — see
[ide/pycharm/README.md](ide/pycharm/README.md).

Starting uvicorn directly works too, and is what the launcher does underneath:

```shell
uvicorn dashboard.backend.app:app --port 8000
```

Then open `http://localhost:8000`. The API lives under `/api`; `GET /api/health`
reports whether the packs are consistent with the scenario YAMLs they reference,
and `/docs` gives an interactive API browser (that page alone needs internet, for
its CDN assets).

### Demo mode

`http://localhost:8000/?mock=1` runs the whole interface off the captured
payloads in `fixtures/`, including a simulated run that fills a progress bar. No
engine involved — useful for demonstrating the dashboard on a machine that has
no Illuminator environment, and for working on the UI without waiting for runs.

**Run with a single worker** (the launcher and uvicorn's default both do).
The run manager lives in the server process — it enforces the one-simulation-at-a-time limit and tracks the
subprocess handles — so `--workers N` would create N independent managers with
inconsistent views of the run registry.

**The working directory must be the repository root.** The engine resolves
several paths relative to it, including the monitor-file directory it validates
when loading a scenario, and the tutorial YAMLs are written relative to the root.
`run_dashboard.py` changes to it automatically, so the launcher can be started
from anywhere; invoking uvicorn yourself, you have to be there already. The run
manager starts each simulation subprocess with that working directory too.

## Using it

Pick a task along the top, set the sliders, press **Simulate**. The diagram,
the charts and the results table fill in as the simulation runs; **Stop**
abandons it and **Reset** returns every setting to the tutorial's defaults. The first task of each pack is
a *dataset view*: it has no Simulate button and redraws immediately as you change
the settings, because it reads the data files directly rather than simulating.

Out-of-range values are clamped rather than rejected, and the clamp is reported
under the sliders. If a simulation is already running, starting another offers to
stop the first — only one runs at a time.

### The energy system

Simulation tasks show the system itself above the charts: an icon per asset,
wired the way the scenario connects them. While a simulation runs the diagram
comes alive — dashes travel along each power flow, thicker and faster the larger
the flow, arrows point the way the power actually goes at that moment, and the
battery's charge bar fills and empties.

One timestep is selected at a time, and everything shows it at once: **the
charts mark it with a dashed rule and a dot on every series, their legends read
that instant (the chip says which), the diagram's badges and flows show it, and
the table highlights that row**. Four ways to move it — drag the scrubber under
the diagram, click a chart, click a row in the table, or press ▶ to play the day
back. It follows the newest step while a run is in progress.

Hovering a chart is a separate, lighter question: a readout follows the pointer
with every series' value at the moment under it (and its pinned value, when a
run is pinned), without changing what is selected.

Tap an asset to see what it is set to and what it is doing: the settings that
target that model, and its readings at the selected step. Both are derived from
the pack — a control belongs to an asset when one of its targets writes that
model — so a new tutorial gets the panel for free.

Everything drawn comes from the scenario YAML plus the pack's `topology:` block
(positions, hidden nodes, which result column animates which edge), so a new
tutorial gets a diagram by writing a pack, not code — and a scenario with no
overlay still renders with an automatic layout.

Two things the scenario cannot supply, the pack adds:

* **`extra_nodes`** — assets the diagram needs that are not Illuminator models.
  The national grid is the case in point: the power balance closes there, but
  the tutorial reports the exchange as a controller column (`Controller1.dump`,
  positive when exporting) rather than as a model. A `flows:` entry naming an
  extra node creates that edge as well as binding it.
* **badge flags** — `abs: true` prints the magnitude, leaving direction to the
  arrow (right for the grid and the battery, whose columns are signed), and
  `bar: true` also draws the value as a fill under the icon (the battery's
  state of charge).

Flow arrows follow the *realised* quantity wherever the scenario offers a
choice: the controller-to-battery edge animates `Battery1.p_out`, the power the
battery actually moved once its capacity and efficiency were applied, not the
controller's `flow2b` request.

### Comparing two runs

A single curve answers "what happened"; two answer "what did this setting do".
Pressing **Simulate** again keeps the run you were looking at: it is redrawn as a
dashed ghost under the new one, and a bar above the charts names the settings
that differ. **Pin this run** keeps a run of your choosing instead — an explicit
pin outranks the automatic one and stays until you unpin it or replace it, so
you can vary three settings in turn against one baseline.

Underneath the charts, **Day totals** reduces each monitored quantity to one
number per run and states the change between them. Flows are totalled over
every step of the run; a level such as state of charge is averaged instead —
adding up 96 readings of a level would mean nothing. Two curves are hard to
compare by eye; one number each is not.

Below that, **Every timestep** lists the raw results one row per simulation
step, the quantities being whatever the pack's `summary:` block names. Rows are
appended as the run produces them, so it fills in live and your scroll position
survives.

The comparison belongs to one case: switching task, or pressing **Reset**,
clears it.

## How it works

```
browser ──HTTP──> FastAPI (dashboard/backend/app.py)
                      │
                      ├─ packs.py      pack config + topology derived from scenario YAML
                      ├─ baseline.py   dataset cases, read straight from the data files
                      └─ runs.py       run manager
                              │ spawns
                              └──> runner.py (subprocess, cwd = repo root)
                                       └── illuminator.engine.Simulation
                                                 └── writes out.csv row by row

frontend/  (static, no build step, ES modules)
  index.html    shell
  app.js        state machine: case selection, run lifecycle, polling
  api.js        the only place that talks to the backend; also serves mock mode
  controls.js   sliders/toggles/day picker built from the pack schema
  charts.js     uPlot wrappers, the results table and the run comparison;
                chart hover readout and click-to-select
  topology.js   the energy-system diagram: icons, animated flows, time scrubber,
                asset panel; owns the selected timestep for the whole panel
  vendor/       uPlot 1.6.32, vendored so the page works offline
```

The frontend is deliberately plain: ES modules served as-is, no bundler, no
package.json, nothing to compile. Editing a file and reloading the page is the
whole development loop.

**Result columns are always looked up by name.** The collector's column order
varies between runs of the same scenario, so indexing positionally would quietly
plot the wrong series — `charts.js` rebuilds a name→index map on every update.

**A chart's click handler captures on the holder, not the plot area.** uPlot's
default `cursor.drag.click` calls `stopImmediatePropagation` from a capture-phase
listener on its own wrapper, so a `click` listener bound to `.u-over` never runs.
Binding one level up, in the capture phase, gets there first.

**Two runs are aligned on elapsed time, not the wall clock.** uPlot gives all
series one x axis, so the pinned run is placed on the current run's clock by
seconds since each run's own first sample. Two runs of the same day land exactly
on top of each other, and a summer day still overlays a winter one hour for hour.
Sample times only one run has become `null` in the other, so uPlot leaves a gap
rather than inventing a value.

Simulations run in a **subprocess**, never in the web server:

* Mosaik creates and owns an asyncio event loop, which would collide with
  uvicorn's (the notebooks paper over the same clash with `nest_asyncio`).
* `illuminator.engine.current_model` is module-global state the engine mutates
  while starting simulators, so two runs in one process would corrupt each other.
* A crash or hang cannot take the server down, and cancelling is just a signal.

Each run gets a directory under `dashboard/runs/` (gitignored) holding
`spec.json` (the full resolved run description), `status.json`, `out.csv` and
`run.log` — enough to reproduce or debug it on its own. Progress is the number of
rows in `out.csv` against the expected step count, so results can be read while a
run is still going.

Runs are quick: a one-day Tutorial 1 scenario takes roughly 1–2 seconds on a
laptop (longer on a Raspberry Pi). Only one runs at a time by default
(`MAX_CONCURRENT` in `runs.py`); a second request gets a 409 naming the run
holding the slot.

## Adding or editing a tutorial

Everything the dashboard shows for a case comes from a pack file in `packs/`;
adding a tutorial means adding a pack, not changing code. See
`packs/power_balance.yaml` for a worked example. A case declares:

* `scenario` — the Illuminator YAML to run (`kind: simulation`), or `baseline` —
  a data file to read directly (`kind: dataset`, no engine involved).
* `csv_overrides` — data file per CSV model. **Always set these.** Several
  committed tutorial YAMLs point at paths that no longer exist (for example
  `Tutorial_Power_Balance_a.yaml` refers to `Tutorial1/Tutorial1/load_data.txt`),
  and the notebooks override them too.
* `controls` — sliders and toggles. Each writes one or more scenario parameters
  via `targets`, with an optional per-target `scale`, so related parameters
  cannot drift apart. The "Battery power limit" slider, for instance, writes
  `Battery1.max_p`, `Battery1.min_p` (negated) and `Controller1.max_p` together.
* `states` — initial model states (battery charge at the start of the day),
  applied with `set_model_state`.
* `monitor_items` — what to record. The committed YAMLs monitor only a subset
  (some just one column), so the pack decides what the dashboard needs.
* `summary` — the quantities the results table and the day totals show, with
  their labels. `sum_columns` are flows (totalled); `sample_columns` are levels
  (averaged).
* `charts`, `summary`, `topology` — how to present the results.

Every parameter a control targets **must be declared in that scenario's YAML**:
`edit_models` raises `KeyError` otherwise. Check a pack before running it:

```shell
python -m dashboard.backend.packs
```

This validates every pack against its scenarios — control targets, state targets,
monitor items, chart/badge/flow columns, data files and day ranges — and exits
non-zero on any problem. `GET /api/health` reports the same.

### Slider ranges

Defaults match the tutorial notebooks exactly. The `min`/`max`/`step` spans are a
pedagogical choice — wide enough to make the trade-off visible, not derived from
anything physical — and are meant to be tuned. Values outside a range are
clamped, not rejected, and the clamp is reported in the response `notes`.

### Day ranges

The tutorial data covers 2012 at 15-minute resolution. The wind series ends on
2012-12-30, which sets `day.max` for the power-balance pack. Scenario
`time_resolution` stays at 900 s: the CSV reader raises if timestamps do not line
up with the simulation clock, so resolution is deliberately not exposed.

## Tests

The backend has no test suite of its own yet; `python -m dashboard.backend.packs`
validates the packs, and `/api/health` reports the same. The frontend has
browser-less tests in `tools/frontend_tests/` — see the README there.

## API

See [API.md](API.md) for the full contract, and `fixtures/` for real captured
payloads. Refresh the fixtures with:

```shell
python -m dashboard.tools.capture_fixtures --http http://localhost:8000
```

(omit `--http` to capture without a running server).

## Future work

* **Raspberry Pi kiosk provisioning** — systemd unit, Chromium autostart, screen
  blanking. The dashboard is built to be Pi-capable (offline assets, light
  animation, progress-first UX); only the provisioning is missing.
* **Run history** — the runs on disk outlive the page, so an earlier session's
  run could be reopened and pinned. Today the comparison only reaches back to the
  run before this one.
* **Tutorial 2 (electricity markets)** — another pack, plus whatever chart kinds
  its agent-based results need.
* **Adding models from the UI** — the generic topology derivation (any scenario
  renders, with or without a pack overlay) and `Simulation.add_model` /
  `add_connection` are the intended hooks. Writing changes back to a scenario
  YAML is the part that does not exist yet.
