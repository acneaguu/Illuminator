# PyCharm run configurations

Ready-made run configurations for the dashboard. Copy them into the project's
`.idea/` folder — PyCharm picks them up within a second or two, no restart:

```shell
# from the repository root
cp -r dashboard/ide/pycharm/runConfigurations .idea/
```

They then appear in the run selector under a **Dashboard** folder:

| Configuration | What it does |
|---|---|
| **Dashboard** | Starts the server and opens a browser. The everyday one. |
| **Dashboard (demo data)** | Opens with `?mock=1`: the whole interface runs off the captured payloads in `fixtures/`, starting no simulations. Useful for showing the dashboard on a machine with no Illuminator environment. |
| **Dashboard (dev, reload)** | Restarts the server when code changes. Handy while editing the backend; it abandons any simulation in progress. |
| **Check packs** | Validates every pack against the scenario YAMLs it references. Run it after editing a pack. |

Stop the server with the red stop button, or Ctrl+C in the run window.

## What they assume

* The project SDK is the conda environment the Illuminator runs in
  (`/opt/anaconda3/envs/illuminator` here). The configurations use the module
  SDK, so they follow whatever the project is set to.
* The module is named `illuminator` — PyCharm's default for this project. If
  your module has a different name, edit the `<module name="…" />` line, or just
  recreate the configuration through the UI (below).
* The working directory is the repository root, which the Illuminator engine
  requires: it resolves scenario and data paths relative to it.

## Making one by hand instead

Four clicks, if you would rather not copy files:

1. **Run → Edit Configurations… → + → Python**
2. **Script path**: `dashboard/run_dashboard.py`
3. **Working directory**: the repository root
4. **Python interpreter**: the `illuminator` conda environment

Add `--demo` or `--reload` under *Script parameters* for the variants.

## Without PyCharm

The configurations are only a wrapper around the launcher, which works anywhere:

```shell
python dashboard/run_dashboard.py            # serve and open a browser
python dashboard/run_dashboard.py --demo     # captured data, no engine
python dashboard/run_dashboard.py --help     # host, port, reload, no-browser
```
