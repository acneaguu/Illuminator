"""Dataset cases: profiles read straight from the data files, no simulation.

Tutorial 1 opens with the neighbourhood's demand on its own, before any local
generation exists, stacked by the sources the national grid mix would use to
meet it. Tutorial 3 opens with the same demand drawn against the capacity of the
grid connection. Neither runs the engine, so they answer instantly and give the
dashboard something to show while nothing is simulating.

Mirrors ``examples/Tutorial1/functions_T1.plot_load_profile`` and
``examples/Tutorial3/functions_T3.plot_load_on_connection``.
"""

from __future__ import annotations

import datetime as _dt
from pathlib import Path
from typing import Any, Dict, Optional

from . import packs

#: Colours the tutorial uses for the NL electricity mix, in its own order.
MIX_COLORS = {
    "coal": "brown",
    "Oil": "black",
    "Nuclear": "yellow",
    "Biofuels": "darkgreen",
    "Waste": "tomato",
    "Hydro": "blue",
    "Natural Gas": "lightgrey",
    "Solar": "limegreen",
    "Wind": "skyblue",
    "Other": "bisque",
}


def _load_series(path: Path, value_column: str):
    """Read one of the tutorial data files into a time-indexed Series.

    The files carry a title line above the real header (``Load_data`` then
    ``time,load``), which is why the tutorials read them with ``skiprows=1``.
    """
    import pandas as pd

    frame = pd.read_csv(path, delimiter=",", skiprows=1)
    time_column = frame.columns[0]
    frame[time_column] = pd.to_datetime(frame[time_column])
    frame = frame.set_index(time_column)
    if value_column not in frame.columns:
        raise KeyError(
            f"column '{value_column}' not in {path.name}; available: {list(frame.columns)}"
        )
    return frame[value_column]


def profile(pack: dict, case: dict, day: str, settings: Dict[str, Any]) -> Dict[str, Any]:
    """The scaled profile for one day, plus optional stacked mix layers.

    ``scale_by`` names the control whose value multiplies the series -- the
    number of houses, in the tutorials; nothing here knows which. ``scale:
    power`` reproduces the tutorial's conversion of 15-minute energy readings to
    average power (``load * factor * 15/60``); ``raw`` multiplies only, as
    Tutorial 3's opening plot does.
    """
    spec = case["baseline"]
    scale_control = spec.get("scale_by")
    factor = float(settings.get(scale_control, 1) or 1) if scale_control else 1.0

    series = _load_series(packs.data_dir_for(pack) / spec["file"], spec["value_column"])

    scale_mode = spec.get("scale", "raw")
    if scale_mode == "power":
        scaled = series * factor * 15 / 60
    elif scale_mode in ("raw", "energy"):
        scaled = series * factor
    else:
        raise ValueError(f"unsupported baseline scale {scale_mode!r}")

    start = _dt.datetime.fromisoformat(f"{day} 00:00:00")
    end = _dt.datetime.fromisoformat(f"{day} 23:45:00")
    window = scaled.loc[start:end]
    if window.empty:
        raise ValueError(f"no data for {day} in {spec['file']}")

    timestamps = [t.strftime("%Y-%m-%d %H:%M:%S") for t in window.index]
    total = [round(float(v), 6) for v in window.tolist()]

    result: Dict[str, Any] = {
        "pack": pack["id"],
        "case": case["id"],
        "kind": "dataset",
        "day": day,
        "unit": spec.get("unit", "kW"),
        "label": spec.get("label", "Load"),
        "timestamps": timestamps,
        "total": total,
        "settings": settings,
    }

    if spec.get("mix"):
        result["layers"] = _mix_layers(window, spec["mix"])
    return result


def _mix_layers(window, mix: Dict[str, float]):
    """Split the load curve into generation-mix layers.

    Greedy, exactly as the tutorial does it: each source supplies the lesser of
    its share of the total load and whatever load is still unmet, so the layers
    stack up to the load curve.
    """
    import numpy as np

    remaining = window.copy()
    layers = []
    for source, share in mix.items():
        contribution = np.minimum(remaining, share * window)
        remaining = remaining - contribution
        layers.append({
            "name": source,
            "share": share,
            "color": MIX_COLORS.get(source),
            "values": [round(float(v), 6) for v in contribution.tolist()],
        })
    return layers


def available_days(pack: dict, case: dict) -> Dict[str, Optional[str]]:
    """First and last day present in a dataset case's file."""
    spec = case["baseline"]
    series = _load_series(packs.data_dir_for(pack) / spec["file"], spec["value_column"])
    if series.empty:
        return {"first": None, "last": None}
    return {
        "first": series.index[0].strftime("%Y-%m-%d"),
        "last": series.index[-1].strftime("%Y-%m-%d"),
    }
