# Frontend tests

Runs the real dashboard frontend in [jsdom](https://github.com/jsdom/jsdom) and
drives it against genuine backend payloads, so the UI can be verified without a
browser — useful in CI, and essential where a sandbox forbids binding a port.

These are **optional development tooling**. They are not needed to run the
dashboard and jsdom is deliberately not a project dependency.

## Running them

```shell
# 1. Export live payloads from the Python backend (runs a real simulation)
python -m dashboard.tools.frontend_tests.export_session

# 2. Install jsdom somewhere scratch, and run
cd "$TMPDIR" && npm install jsdom --cache "$TMPDIR/npm-cache"
cd /path/to/repo/dashboard/tools/frontend_tests
NODE_PATH="$TMPDIR/node_modules" node test-app.mjs
NODE_PATH="$TMPDIR/node_modules" node test-edges.mjs
```

`test-app.mjs` covers the happy path: pack loading, tab switching, controls
rendered from the schema, a simulation run with progressive polling, charts,
the per-step results table, the topology view (badges, flow directions, the
time scrubber, playback, the asset panel and the timestep the charts and table
follow) and run comparison (pin, ghost curves, day totals). `test-edges.mjs`
covers engine failure, cancellation, the 409 conflict takeover, the tutorial
switcher (including the `?pack=` deep link), leaving a case while a run is still
in flight, mock mode, and the column-order defence.

`NODE_PATH` works because the harness resolves jsdom through `require`; set
`JSDOM_PATH` to an explicit path instead if you prefer.

## What the harness shims

jsdom implements no canvas, so `harness.mjs` supplies `Path2D`, a recording 2D
context, `matchMedia`, `ResizeObserver`, non-zero element sizes and a duck-typed
`Response`. uPlot runs for real against these — the tests assert on the number of
drawing calls and on the values uPlot was handed, not on pixels.

The one thing this cannot check is appearance. Look at the page in a real browser
before shipping visual changes.
