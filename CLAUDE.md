# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The Illuminator is a Python package (`src/` layout, package name `illuminator`) that wraps the
[Mosaik](https://mosaik.offis.de/) co-simulation framework. Users describe an energy system as a
YAML *scenario* — a list of models, the connections between them, and what to monitor — and the
engine translates that into a Mosaik world, runs it, and writes results to CSV. Energy models are
Python classes registered in `illuminator.models`. Optional Raspberry Pi cluster and MPI
multi-scenario execution are built on the same scenario format.

## Commands

```shell
# Install for development (editable). Note: the conda env `illuminator` may hold a
# non-editable copy of the package that shadows src/ — check with `pip show illuminator`.
pip install -e ".[dev]"

# Run a scenario
illuminator scenario run <path/to/scenario.yaml>
illuminator scenario run_parallel <path/to/scenario.yaml>   # needs a system MPI library
illuminator cluster build <path/to/scenario.yaml>

# Unit tests. Two modules abort collection and must be excluded, since one collection
# error aborts the entire run (see below)
pytest tests/ --ignore=tests/models/test_pv_mosaik.py --ignore=tests/parallel_scenarios

pytest tests/models/test_pv_model.py                                                # one file
pytest tests/models/test_pv_model.py::TestPVModelMethods::test_aoi_happy_flow_positive_aoi

# End-to-end tests (run from the repo root; scenario paths inside are relative)
python tests/e2e_test.py
diff tests/outputs/out_e2e_T1.csv        tests/outputs/expected_out_e2e_T1.csv
diff tests/outputs/out_e2e_T3.csv        tests/outputs/expected_out_e2e_T3.csv
diff tests/outputs/out_e2e_hydrogen.csv  tests/outputs/expected_out_e2e_hydrogen.csv

# Docs
pip install -r docs/requirements.txt && sphinx-build docs _build
```

### Test-suite quirks worth knowing before you debug them

There is no pytest config anywhere in the repo, so the default collection rules apply and bite in
three ways:

- **Neither `pytest` nor `pytest tests/` runs anything as-is.** Both abort during collection:
  `tests/models/test_pv_mosaik.py` imports a pre-3.0 module that no longer resolves, and
  `tests/parallel_scenarios/` needs a working system MPI library. Bare `pytest` at the root
  additionally picks up `examples/IDE_case/test_justice_score.py` and
  `src/illuminator/models/test_model.py`. Use the `--ignore` invocation above.
- **Collecting `tests/` runs the whole e2e suite as a side effect.** `tests/e2e_test.py` matches
  pytest's default `*_test.py` pattern, and it calls `tutorial1()`, `tutorial3()` and `hydrogen()`
  at module level — so three full simulations execute at collection time and overwrite
  `tests/outputs/out_e2e_*.csv`, even when you asked for an unrelated test.
- **One pre-existing failure.** `tests/test_engine.py::TestStartSimulators::test_number_entities`
  fails on a stale fixture (its CSV model passes `datafile`, but `start_simulators` requires
  `file_path`). Baseline is 22 passed / 1 failed / 1 skipped — that failure is not yours.

The e2e `diff` checks are order-sensitive and currently fail locally: the values match the committed
expectations exactly, but the **column order differs**. `collector_v3.inputs2df()` takes column
order from the Mosaik input dict rather than from `monitor.items`, and the line that would restore
YAML order (`df = df[self.items]`, `collector_v3.py:117`) is commented out. Check whether a `diff`
failure is a real numeric regression before regenerating the expected files.

## How a scenario becomes a simulation

`engine.Simulation.run()` (`src/illuminator/engine.py`) is the whole pipeline:

1. `add_collector()` — synthesises a model entry named `Collector` from the `monitor:` section.
   **`Collector` is a reserved model name**; `run()` later looks it up by that exact key.
2. `schema.simulation.load_config_file()` — validates the YAML against a `schema`-library
   definition in `src/illuminator/schema/simulation.py`.
3. `generate_mosaik_configuration()` — one Mosaik simulator per scenario model entry, keyed by the
   model's **`name`** and resolved to the class `illuminator.models:<type>`. So `name` is the Mosaik
   simulator id and `type` must match a class exported from `src/illuminator/models/__init__.py`.
4. `start_simulators()` — `world.start(name, ...)` then `create(num=1)`: exactly one entity per
   simulator, which is why the rest of the engine can index `model_entities[name][0]`.
5. `build_connections()` then `connect_monitor()` — see the connection rules below.
6. `compute_mosaik_end_time()` converts `start_time`/`end_time`/`time_resolution` into a Mosaik
   step count for `world.run(until=...)`.

### YAML values reach models through a global

There is no constructor plumbing. `start_simulators()` calls `engine.set_current_model(model)`
immediately before `world.start()`, and `ModelConstructor.__init__` reads the module-level
`engine.current_model` dict to pick up that model's `parameters`, `inputs`, `outputs`, `states` and
`time_step_size`, falling back to the class-level defaults. Consequences to keep in mind:

- Models must be started sequentially, in-process. Anything that reorders or parallelises
  `start_simulators` breaks this.
- `set_current_model` assigns each key under its own `try/except` and does **not** clear the dict
  between models, so a model that omits a section keeps the previous model's values for it.
- `CSV_reader_v3.py` exploits the global deliberately: it writes its CSV column names into
  `current_model['states']`, then calls `super().__init__()` a second time to rebuild the Mosaik
  meta with those columns.

### Connections: `outputs` are physical, `states` are informational

Everything sent over a Mosaik connection is wrapped as `{'message_origin': 'output'|'state',
'value': ...}`. Models must publish with `self.set_outputs({...})` / `self.set_states({...})` and
read with `self.unpack_inputs(inputs)` (`src/illuminator/builder/model.py`) — a raw value on a
connection raises at runtime. The two channels differ:

| | `outputs` (physical) | `states` (informational) |
|---|---|---|
| many sources → one input | **summed** by `unpack_inputs` | delivered as a list |
| one source → many destinations | rejected by `build_connections` as a "physical split" | allowed |

Other rules encoded in code, not just docs:

- An attribute name may not appear in both `outputs` and `states`
  (`IlluminatorModel._validate_attributes`).
- `time_shifted: true` on a connection breaks an algebraic loop (e.g. `Controller1.flow2b →
  Battery1.flow2b`). The source attribute must be declared in the source model's `outputs` or
  `states` so an initial value exists for step 0.
- Monitored items bypass the split check and are always `(attr, "<model>.<attr>")`-renamed into the
  Collector.

### Time

Mosaik passes the world's `time_resolution` (seconds per Mosaik step) into
`ModelConstructor.init()`, so `self.time_resolution` is seconds-per-step and `step()` returns
`time + self.time_step_size` in Mosaik steps. Wall-clock seconds advanced per model step is
therefore `time_step_size * time_resolution` — this is how `CSV_reader_v3` and `collector_v3`
derive timestamps and how `battery_v3` derives `hours`.

## Adding or changing a model

1. Subclass `ModelConstructor` (`from illuminator.builder import ModelConstructor`) in
   `src/illuminator/models/<Area>/<name>_v3.py`. Declare `parameters`, `inputs`, `outputs`,
   `states`, `time_step_size` as **class attributes** — these are the defaults used when the YAML
   omits them.
2. Implement `step(self, time, inputs, max_advance)`: `unpack_inputs(inputs)` → compute →
   `set_outputs(...)` / `set_states(...)` → `return time + self._model.time_step_size`.
   Read configuration off `self._model.parameters` / `.states` (usually in `__init__`).
3. Export the class from `src/illuminator/models/__init__.py` **and** add it to `__all__`.
   Scenario `type:` values are resolved against that module.
4. `src/illuminator/models/adder.py` is the minimal reference implementation;
   `Battery/battery_v3.py` is a representative real one.

For a model that should not live in the package (tutorials, one-off experiments), pass the class to
`illuminator.models.import_custom_model.import_custom_model()`, which attaches it to
`illuminator.models` at runtime. The `hydrogen()` case in `tests/e2e_test.py` shows the pattern.

### Three generations of models coexist

`src/illuminator/models/` holds ~35 `*_v3.py` files (current, `ModelConstructor`-based) alongside
~30 `*_mosaik.py` + ~27 `*_model.py` files from the pre-3.0 design (raw `mosaik_api` v1 adapters
plus a plain-Python model class), and `emma/` subdirectories of researcher-specific variants.
**Only the `*_v3.py` classes listed in `models/__init__.py` are reachable from a scenario.** The
legacy files are still imported by some older unit tests but are otherwise dead; do not route new
work through them unless asked. Some legacy modules no longer import at all (e.g.
`tests/models/test_pv_mosaik.py` errors on collection).

## Special model types

- **`CSV`** (`models/CSV_reader_v3.py`) — reads a timeseries file and exposes each column as a
  state. Requires `file_path`; `start` defaults to the scenario start time. Raises if a row's
  timestamp doesn't match the expected simulation time, so data resolution must match
  `time_resolution`.
- **`Collector`** (`models/Collector/collector_v3.py`) — writes monitored attributes to
  `monitor.file` one row per step, and is the only model with `any_inputs: True` in its meta. Its
  column order is whatever the Mosaik input dict yields, not `monitor.items` order, and step 0's
  timestamp is deliberately written date-only (`'YYYY-MM-DD'`) with a "TEMPORARY TO PASS E2E TESTS"
  comment.
- `start_simulators()` special-cases both types, passing `sim_start` and `datafile` to
  `world.start()` instead of the normal path.

## Python API for scenario variations

`engine.Simulation` exposes programmatic overrides so one YAML can serve many cases without being
copied — this is how the tutorials and e2e tests work:

```python
sim = Simulation('scenario.yaml')
sim.set_scenario_param('end_time', '2012-02-01 23:45:00')
sim.set_monitor_param('file', 'tests/outputs/out.csv')
sim.edit_models({'Battery1': {'max_p': 40}, 'Load1': {'houses': 10}})
sim.run()
```

Also available: `set_model_param`, `set_model_parameters`, `set_model_state`, `add_model`,
`remove_model`, `add_connection`, `remove_connection`.

## Parallel scenarios (MPI)

A model may declare `multi_parameters` (lists, or a `'range(start, stop, step)'` string) and the
scenario may set `align_parameters`. `parallel_scenarios.run_parallel_file()` strips those, expands
them into the Cartesian product (or a positional zip when `align_parameters: true`), writes one
`<scenario>_<n>.yaml` and one `<output>_<n>.csv` per combination plus a `scenariotable.csv` lookup
table, and distributes the combinations across MPI ranks. `mpi4py` is imported lazily inside the
CLI command so the rest of the CLI works without a system MPI library.

## Repository conventions

- **Branching**: feature branches off `dev`; PRs into `main` are accepted **only** from `dev`
  (enforced by `.github/workflows/restrict-main-pr.yml`).
- **CI**: the e2e workflow runs only on PRs targeting `dev`, and asserts byte-exact `diff` against
  committed expected CSVs — a numerically harmless model change will fail it, and the expected
  files must be regenerated deliberately. A separate workflow builds the current commit against the
  `Illuminator-team/educational_material` repo (`dev` branch) and runs its tests, so scenario-format
  changes can break that repo.
- Docstrings follow [numpydoc](https://numpydoc.readthedocs.io/en/latest/format.html); PEP 8 /
  flake8 per CONTRIBUTING.md, though no linter or formatter is configured or run in CI.
- Dependencies in `pyproject.toml` are pinned exactly (`pandas==1.5.3`, `numpy==1.26.4`, …), which
  in practice constrains the project to Python 3.11 despite `requires-python = ">=3.8"`.