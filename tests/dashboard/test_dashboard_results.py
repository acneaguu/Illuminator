"""Unit tests for ``dashboard.backend.results`` -- the collector-CSV readers.

These pin the quirk absorption the rest of the dashboard leans on: the torn
last line while a run is appending, the collector's date-only step-0 timestamp,
and incremental paging with ``since``/``next``.
"""

from dashboard.backend import results

HEADER = "date,Load1.load_dem,Battery1.soc\n"


def write(tmp_path, text):
    path = tmp_path / "out.csv"
    path.write_text(text, encoding="utf-8")
    return path


def test_row_count_of_missing_and_header_only_files(tmp_path):
    assert results.row_count(tmp_path / "nope.csv") == 0
    assert results.row_count(write(tmp_path, HEADER)) == 0


def test_torn_last_line_is_dropped_and_step0_timestamp_padded(tmp_path):
    # The collector may be mid-append: the second row has no newline yet.
    path = write(tmp_path, HEADER + "2012-06-01,1.0,90.0\n2012-06-01 00:15:00,2.0,89")
    assert results.row_count(path) == 1
    payload = results.read_results(path)
    assert payload["total"] == 1
    assert payload["rows"][0][0] == "2012-06-01 00:00:00"


def test_incremental_paging_produces_no_gaps_or_duplicates(tmp_path):
    rows = "".join(f"2012-06-01 {i:02d}:00:00,{i}.0,90.0\n" for i in range(5))
    path = write(tmp_path, HEADER + rows)

    first = results.read_results(path, since=0, limit=2)
    second = results.read_results(path, since=first["next"])
    assert [row[1] for row in first["rows"]] == [0.0, 1.0]
    assert [row[1] for row in second["rows"]] == [2.0, 3.0, 4.0]
    assert second["next"] == second["total"] == 5


def test_since_beyond_the_end_returns_an_empty_page(tmp_path):
    path = write(tmp_path, HEADER + "2012-06-01,1.0,90.0\n")
    payload = results.read_results(path, since=10)
    assert payload["rows"] == []
    assert payload["next"] == payload["total"] == 1


def test_column_ranges_skip_non_numeric_values(tmp_path):
    path = write(tmp_path, HEADER + "2012-06-01,1.5,90.0\n2012-06-01 00:15:00,-2.0,oops\n")
    ranges = results.column_ranges(path)
    assert ranges["Load1.load_dem"] == {"min": -2.0, "max": 1.5}
    assert ranges["Battery1.soc"] == {"min": 90.0, "max": 90.0}


def test_hourly_summary_sums_flows_and_samples_levels(tmp_path):
    lines = [HEADER]
    for hour in (0, 1):
        for quarter in range(4):
            soc = 80 + hour * 10 + quarter
            lines.append(f"2012-06-01 {hour:02d}:{quarter * 15:02d}:00,1.0,{soc}\n")
    path = write(tmp_path, "".join(lines))

    payload = results.hourly_summary(
        path,
        sum_columns={"Load1.load_dem": "Load (kW)"},
        sample_columns={"Battery1.soc": "SOC (%)"},
    )
    assert [column["agg"] for column in payload["columns"]] == ["sum", "sample"]
    # Four quarter-hour flows summed; the level sampled at the hour boundary.
    assert payload["rows"][0]["values"] == [4.0, 80.0]
    assert payload["rows"][1]["values"] == [4.0, 90.0]
