"""Unit tests for ``dashboard.backend.packs`` and the baseline profile maths.

The pure functions here are what every pack -- current and future -- passes
through, so this is where control normalisation, clamping, the engine-mirroring
arithmetic and the pack self-check get pinned down.
"""

import os

import pytest

from dashboard.backend import baseline, packs


# ---------------------------------------------------------------- helpers

def make_dataset_case():
    pack = {"id": "p", "title": "P"}
    raw = {
        "id": "c",
        "kind": "dataset",
        "day": {"default": "2012-06-01", "min": "2012-01-01", "max": "2012-12-30"},
        "baseline": {"file": "data.txt"},
        "controls": [
            {"id": "houses", "type": "slider", "min": 1, "max": 50, "step": 1,
             "default": 5, "targets": []},
            {"id": "boost", "type": "toggle", "default": False, "targets": []},
        ],
    }
    return packs._normalise_case(pack, raw, 0)


# ------------------------------------------------- control normalisation

def test_shorthand_model_param_becomes_a_target():
    control = packs._normalise_control(
        {"model": "PV1", "param": "cap", "type": "slider",
         "min": 0, "max": 1, "step": 0.1, "default": 0.5}, 0)
    assert control["targets"] == [{"model": "PV1", "param": "cap", "scale": 1.0}]
    assert control["id"] == "cap"


def test_control_without_targets_needs_an_explicit_id():
    with pytest.raises(packs.PackError):
        packs._normalise_control(
            {"targets": [], "type": "slider", "min": 0, "max": 1, "step": 1, "default": 0}, 0)


def test_slider_requires_its_full_range():
    with pytest.raises(packs.PackError):
        packs._normalise_control({"id": "x", "targets": [], "type": "slider"}, 0)


# ------------------------------------------------------ settings resolution

def test_resolve_settings_clamps_and_notes_unknowns():
    case = make_dataset_case()
    values, notes = packs.resolve_settings(case, {"houses": 99, "nope": 1})
    assert values["houses"] == 50.0
    assert any("clamped" in note for note in notes)
    assert any("unknown control 'nope'" in note for note in notes)


def test_toggles_accept_query_string_text():
    # The baseline route passes control values straight off the query string.
    case = make_dataset_case()
    assert packs.resolve_settings(case, {"boost": "false"})[0]["boost"] is False
    assert packs.resolve_settings(case, {"boost": "true"})[0]["boost"] is True
    values, notes = packs.resolve_settings(case, {"boost": "maybe"})
    assert values["boost"] is False
    assert any("not a boolean" in note for note in notes)


def test_build_new_settings_scales_targets_and_keeps_integers():
    case = packs._normalise_case({"id": "p", "title": "P"}, {
        "id": "c", "kind": "simulation", "scenario": "x.yaml",
        "day": {"default": "2012-06-01"},
        "controls": [
            {"id": "battery_power", "type": "slider", "min": 0.1, "max": 5,
             "step": 0.1, "default": 0.8,
             "targets": [{"model": "Battery1", "param": "max_p"},
                         {"model": "Battery1", "param": "min_p", "scale": -1},
                         {"model": "Controller1", "param": "max_p"}]},
            {"id": "houses", "type": "slider", "min": 1, "max": 50, "step": 1,
             "default": 5, "targets": [{"model": "Load1", "param": "houses"}]},
        ],
    }, 0)
    settings = packs.build_new_settings(case, {"battery_power": 2.5, "houses": 8.0})
    assert settings["Battery1"] == {"max_p": 2.5, "min_p": -2.5}
    assert settings["Controller1"] == {"max_p": 2.5}
    assert settings["Load1"]["houses"] == 8
    assert isinstance(settings["Load1"]["houses"], int)


# -------------------------------------------------------- days and steps

def test_validate_day_bounds_and_format():
    case = make_dataset_case()
    assert packs.validate_day(case, None) == "2012-06-01"
    with pytest.raises(ValueError):
        packs.validate_day(case, "2013-01-01")
    with pytest.raises(ValueError):
        packs.validate_day(case, "01/06/2012")


def test_expected_steps_mirror_the_engine_arithmetic():
    start, end = packs.day_window("2012-06-01")
    assert (start, end) == ("2012-06-01 00:00:00", "2012-06-01 23:45:00")
    assert packs.expected_steps(start, end, 900) == 95


def test_category_prefixes_cover_the_controller_variants():
    assert packs.category_for("ControllerT3Congestion") == "controller"
    assert packs.category_for("Battery") == "battery"
    assert packs.category_for("SomethingNew") == "generic"


# ------------------------------------------------------------- pack cache

def test_pack_cache_refreshes_when_the_file_changes(tmp_path, monkeypatch):
    monkeypatch.setattr(packs, "PACKS_DIR", tmp_path)
    packs._PACK_CACHE.clear()
    path = tmp_path / "demo.yaml"

    def write_pack(title):
        path.write_text(
            "id: demo\n"
            f"title: {title}\n"
            "day: {default: '2012-06-01'}\n"
            "cases:\n"
            "  - id: only\n"
            "    kind: dataset\n"
            "    baseline: {file: data.txt}\n",
            encoding="utf-8")

    write_pack("Before")
    assert packs.load_pack("demo")["title"] == "Before"
    write_pack("After")
    os.utime(path, (path.stat().st_atime, path.stat().st_mtime + 5))
    assert packs.load_pack("demo")["title"] == "After"
    packs._PACK_CACHE.clear()


# --------------------------------------------------------- the self-check

def test_check_pack_flags_a_scale_by_that_is_not_a_control(tmp_path, monkeypatch):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / "data.txt").write_text("Load_data\ntime,load\n", encoding="utf-8")
    monkeypatch.setattr(packs, "PACKS_DIR", tmp_path)
    packs._PACK_CACHE.clear()
    (tmp_path / "demo.yaml").write_text(
        "id: demo\n"
        f"data_dir: \"{data_dir.as_posix()}\"\n"
        "day: {default: '2012-06-01'}\n"
        "cases:\n"
        "  - id: only\n"
        "    kind: dataset\n"
        "    baseline: {file: data.txt, scale_by: nope}\n",
        encoding="utf-8")
    problems = packs.check_pack("demo")
    assert any("scale_by 'nope'" in problem for problem in problems)
    packs._PACK_CACHE.clear()


def test_check_pack_flags_an_unknown_extra_node_category(tmp_path, monkeypatch):
    scenario = tmp_path / "scenario.yaml"
    scenario.write_text(
        "scenario: {name: s}\n"
        "models:\n"
        "  - name: B1\n"
        "    type: Battery\n"
        "connections: []\n",
        encoding="utf-8")
    monkeypatch.setattr(packs, "PACKS_DIR", tmp_path)
    packs._PACK_CACHE.clear()
    (tmp_path / "demo.yaml").write_text(
        "id: demo\n"
        f"data_dir: \"{tmp_path.as_posix()}\"\n"
        "day: {default: '2012-06-01'}\n"
        "cases:\n"
        "  - id: only\n"
        "    kind: simulation\n"
        f"    scenario: \"{scenario.as_posix()}\"\n"
        "    topology:\n"
        "      extra_nodes:\n"
        "        - {id: X, category: spaceship, position: [0, 0]}\n",
        encoding="utf-8")
    problems = packs.check_pack("demo")
    assert any("unknown category 'spaceship'" in problem for problem in problems)
    packs._PACK_CACHE.clear()


# ------------------------------------------- the committed pack, for real

def test_committed_packs_are_consistent_with_their_scenarios():
    assert packs.check_all_packs() == []


def test_topology_of_the_battery_case_has_its_virtual_grid():
    pack, case = packs.get_case("power_balance", "res_battery")
    topo = packs.build_topology(pack, case)
    nodes = {node["id"]: node for node in topo["nodes"]}
    assert nodes["Grid"]["virtual"] is True
    assert not any(node["category"] == "data" for node in topo["nodes"])
    bound = {(edge["from"], edge["to"]): edge["column"] for edge in topo["edges"]}
    assert bound[("Controller1", "Battery1")] == "Battery1.p_out"


def test_case_payload_carries_the_controls_heading():
    _, case = packs.get_case("power_balance", "base")
    assert packs.case_payload(case)["controls_heading"] == "Neighbourhood"


# -------------------------------------------------------- baseline maths

def test_baseline_profile_scales_by_the_named_control(tmp_path):
    lines = ["Load_data", "time,load"]
    for hour in range(24):
        for quarter in range(4):
            lines.append(f"2012-06-01 {hour:02d}:{quarter * 15:02d}:00,1.0")
    (tmp_path / "load.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")

    pack = {"id": "p", "title": "P", "data_dir": tmp_path.as_posix(),
            "day": {"default": "2012-06-01"}}
    case = packs._normalise_case(pack, {
        "id": "c", "kind": "dataset",
        "baseline": {"file": "load.txt", "value_column": "load",
                     "scale": "power", "scale_by": "houses",
                     "mix": {"a": 0.25, "b": 0.75}},
        "controls": [{"id": "houses", "type": "slider", "min": 1, "max": 50,
                      "step": 1, "default": 5, "targets": []}],
    }, 0)

    payload = baseline.profile(pack, case, "2012-06-01", {"houses": 4})
    assert len(payload["timestamps"]) == 96
    # 1.0 kWh-per-quarter reading * 4 houses * 15/60 -> 1.0 kW.
    assert payload["total"][0] == pytest.approx(1.0)
    stacked = sum(layer["values"][0] for layer in payload["layers"])
    assert stacked == pytest.approx(payload["total"][0])
