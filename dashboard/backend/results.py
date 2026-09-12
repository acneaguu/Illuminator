"""Readers for the CSV the Illuminator's Collector writes during a run.

Two quirks of ``collector_v3`` shape everything here:

* **Column order is not the order you asked for.** The collector builds each row
  from the Mosaik input dict, so the header order varies between runs and does
  not follow ``monitor.items``. Always read the header; never assume positions.
* **The first data row's timestamp is date-only** (``2012-06-01`` instead of
  ``2012-06-01 00:00:00``) -- there is a "TEMPORARY TO PASS E2E TESTS" branch in
  the collector that formats step 0 differently.

Rows are appended one per simulation step, which is what makes progressive
polling possible while a run is still going.
"""

from __future__ import annotations

import csv
import datetime as _dt
import io
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

DATE_ONLY = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _read_complete_lines(path: Path) -> List[str]:
    """All complete lines of a file, dropping a trailing partial line.

    The collector may be mid-append when we read, so the last line can be torn.
    """
    with open(path, "r", encoding="utf-8", newline="") as handle:
        text = handle.read()
    if not text:
        return []
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()          # file ended with a newline: everything is complete
    elif lines:
        lines.pop()          # last line has no newline yet: incomplete, skip it
    return lines


def _coerce(value: str) -> Any:
    if value == "":
        return None
    try:
        return float(value)
    except ValueError:
        return value


def _normalise_timestamp(value: str) -> str:
    """Pad the collector's date-only step-0 timestamp to a full timestamp."""
    if DATE_ONLY.match(value):
        return f"{value} 00:00:00"
    return value


def row_count(path: Path) -> int:
    """Number of complete data rows written so far (0 if only a header exists)."""
    if not path.exists():
        return 0
    lines = _read_complete_lines(path)
    return max(0, len(lines) - 1)


def read_results(path: Path, since: int = 0, limit: Optional[int] = None) -> Dict[str, Any]:
    """Read result rows, optionally only those after ``since``.

    Parameters
    ----------
    path:
        The run's ``out.csv``.
    since:
        Number of data rows the caller already has. Rows are returned from that
        index onwards, so a poller can pass back the previous ``next`` value.
    limit:
        Maximum number of rows to return.

    Returns
    -------
    dict
        ``{time_column, columns, rows, since, next, total, complete}`` where each
        row is ``[timestamp, *values]`` aligned to ``[time_column] + columns``.
    """
    if not path.exists():
        return {"time_column": None, "columns": [], "rows": [], "since": since,
                "next": since, "total": 0}

    lines = _read_complete_lines(path)
    if not lines:
        return {"time_column": None, "columns": [], "rows": [], "since": since,
                "next": since, "total": 0}

    header = next(csv.reader(io.StringIO(lines[0])))
    time_column, columns = header[0], header[1:]

    total = len(lines) - 1
    start = max(0, min(since, total))
    end = total if limit is None else min(total, start + limit)

    rows: List[List[Any]] = []
    for line in lines[1 + start: 1 + end]:
        fields = next(csv.reader(io.StringIO(line)))
        if not fields:
            continue
        rows.append([_normalise_timestamp(fields[0])] + [_coerce(v) for v in fields[1:]])

    return {
        "time_column": time_column,
        "columns": columns,
        "rows": rows,
        "since": start,
        "next": end,
        "total": total,
    }


def _as_dataframe(path: Path):
    """The full result file as a time-indexed DataFrame (pandas, as the tutorials use)."""
    import pandas as pd

    lines = _read_complete_lines(path)
    if len(lines) < 2:
        return None
    frame = pd.read_csv(io.StringIO("\n".join(lines)), index_col=0)
    frame.index = pd.to_datetime(frame.index)
    return frame


def hourly_summary(path: Path, sum_columns: Dict[str, str],
                   sample_columns: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    """Hourly table of results, mirroring ``functions_T1.summarize_results``.

    ``sum_columns`` are totalled per hour (power/energy flows). ``sample_columns``
    are *sampled* instead -- a state such as battery SOC is a level, not a flow,
    and the tutorial takes every 4th 15-minute value rather than summing them.

    Both arguments map raw result column -> display label.
    """
    sample_columns = sample_columns or {}
    frame = _as_dataframe(path)
    if frame is None:
        return {"columns": [], "rows": []}

    present_sums = [c for c in sum_columns if c in frame.columns]
    present_samples = [c for c in sample_columns if c in frame.columns]

    # 'H' rather than 'h': this environment pins pandas 1.5.3.
    hourly = frame[present_sums].resample("H").sum() if present_sums else None
    if hourly is None:
        hourly = frame.resample("H").size().to_frame("rows").drop(columns=["rows"])

    for column in present_samples:
        # Value at each hour boundary, aligned onto the hourly index. Equivalent
        # to the tutorial's `iloc[::4]` on 15-minute data, which takes the value
        # at 00:00, 01:00, ... rather than summing the four samples in the hour.
        hourly[column] = frame[column].resample("H").first()

    labels = {**sum_columns, **sample_columns}
    ordered = [c for c in list(sum_columns) + list(sample_columns) if c in hourly.columns]
    hourly = hourly[ordered].round(2)

    rows = []
    for timestamp, values in hourly.iterrows():
        rows.append({
            "hour": timestamp.strftime("%H:%M"),
            "date": timestamp.strftime("%Y-%m-%d"),
            "values": [None if _is_nan(v) else float(v) for v in values.tolist()],
        })

    return {
        # ``agg`` tells the frontend how a column may be reduced to one number
        # for the whole day: totalled, or averaged because it is a level.
        "columns": [
            {"key": c, "label": labels[c],
             "agg": "sample" if c in sample_columns else "sum"}
            for c in ordered
        ],
        "rows": rows,
    }


def _is_nan(value: Any) -> bool:
    try:
        return value != value  # NaN is the only value that differs from itself
    except TypeError:
        return False


def column_ranges(path: Path) -> Dict[str, Dict[str, float]]:
    """Per-column min/max over the whole file.

    The topology view normalises each animated flow against its own range, so it
    needs these once a run has finished.
    """
    data = read_results(path)
    ranges: Dict[str, Dict[str, float]] = {}
    for index, column in enumerate(data["columns"], start=1):
        values = [r[index] for r in data["rows"] if isinstance(r[index], (int, float))]
        if values:
            ranges[column] = {"min": min(values), "max": max(values)}
    return ranges


def parse_timestamp(value: str) -> _dt.datetime:
    return _dt.datetime.fromisoformat(_normalise_timestamp(value))
