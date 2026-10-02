"""Data log (SPEC 8): wide CSV / CSV.gz writer, reader round trip, sidecar, export tool."""

from __future__ import annotations

import gzip
import importlib.util
import json
import math
from pathlib import Path

import numpy as np
import pytest

from aerovolt.core.config import PROJECT_ROOT, load_config
from aerovolt.datalog.reader import LogFormatError, LogReader, read_log, read_meta
from aerovolt.datalog.writer import LogWriter, column_format, meta_path_for, write_log


@pytest.fixture(scope="module")
def catalog():
    return load_config(None).catalog


def _load_export_tool():
    spec = importlib.util.spec_from_file_location("export_wide", PROJECT_ROOT / "tools" / "export_wide.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_meta_path_for():
    assert meta_path_for("logs/run1.csv.gz") == Path("logs/run1.meta.json")
    assert meta_path_for("logs/run1.csv") == Path("logs/run1.meta.json")
    assert meta_path_for("/x/y/a.b.CSV.GZ") == Path("/x/y/a.b.meta.json")


def test_column_format_uses_resolution_plus_guard_digit():
    assert column_format(0.1) == "%.2f"
    assert column_format(0.001) == "%.4f"
    assert column_format(1.0) == "%.1f"
    assert column_format(0.0) == "%.7g"


@pytest.mark.parametrize("name", ["run.csv", "run.csv.gz"])
def test_round_trip_all_catalogue_channels(tmp_path, catalog, name):
    channels = list(catalog)
    rng = np.random.default_rng(1)
    n = 50
    t = np.arange(n) * 0.05
    data = np.empty((n, len(channels)))
    for j, ch in enumerate(channels):
        res = ch.resolution or 1e-4
        data[:, j] = np.round(rng.uniform(ch.min, ch.max, n) / res) * res
    data[3, 5] = np.nan
    data[:, 7] = np.nan
    data[10, 9] = np.inf  # never valid: written empty
    path = tmp_path / name
    write_log(path, channels, t, data, meta={"session": {"name": "test"}})

    if name.endswith(".gz"):
        with gzip.open(path, "rt", encoding="utf-8") as fh:
            header, units = fh.readline(), fh.readline()
    else:
        header, units = path.read_text(encoding="utf-8").splitlines()[:2]
    assert header.strip() == "t," + ",".join(ch.id for ch in channels)
    assert units.startswith("#units,s,")

    log = read_log(path)
    assert log.ids == [ch.id for ch in channels]
    assert log.units == [ch.unit for ch in channels]
    assert len(log) == n and log.t == pytest.approx(t)
    expected = data.copy()
    expected[10, 9] = np.nan
    for j, ch in enumerate(channels):
        tol = 0.51 * (ch.resolution or 1e-6) / 10 + 1e-12  # one guard digit beyond resolution
        got, exp = log.values[:, j], expected[:, j]
        assert np.array_equal(np.isnan(got), np.isnan(exp)), ch.id
        ok = ~np.isnan(exp)
        assert np.allclose(got[ok], exp[ok], atol=tol, rtol=1e-6), ch.id
    assert np.isnan(log["fw_p06"][3])
    assert log.meta["session"] == {"name": "test"}
    assert log.meta["rows"] == n and log.meta["t_last"] == pytest.approx(t[-1])
    assert log.duration == pytest.approx(t[-1])


def test_selected_channels_time_window_and_streaming(tmp_path, catalog):
    channels = [catalog["fw_p03"], catalog["amb_temp"], catalog["inv_state"]]
    path = tmp_path / "small.csv"
    rows = [[-400.0 + i, 18.0, float(i % 3)] for i in range(100)]
    write_log(path, channels, [i * 0.05 for i in range(100)], rows)
    log = read_log(path, channels=["inv_state", "fw_p03"], start=1.0, end=2.0)
    assert log.ids == ["inv_state", "fw_p03"]
    assert log.t[0] == pytest.approx(1.0) and log.t[-1] == pytest.approx(2.0)
    assert log["fw_p03"][0] == pytest.approx(-380.0)
    assert log.unit("fw_p03") == "Pa"
    reader = LogReader(path)
    assert "amb_temp" in reader and reader.index("amb_temp") == 1
    first = next(reader.iter_rows(["amb_temp"]))
    assert first[0] == 0.0 and first[1].tolist() == [18.0]
    with pytest.raises(KeyError):
        read_log(path, channels=["nope"])


def test_writer_meta_updates_and_close(tmp_path, catalog):
    path = tmp_path / "logs" / "run.csv.gz"  # parent directory is created
    writer = LogWriter(path, [catalog["fw_p03"]], meta={"mode": "SIM"})
    assert json.loads(meta_path_for(path).read_text())["mode"] == "SIM"
    writer.write_values(0.0, {"fw_p03": -1.0})
    writer.write_values(0.05, {})
    writer.update_meta(laps=[{"lap": 1, "lap_time": 61.2}])
    meta = read_meta(path)
    assert meta["laps"][0]["lap"] == 1 and meta["rows"] == 2 and meta["format"] == "aerovolt-log"
    writer.close(summary={"x": float("nan")})
    writer.close()  # idempotent
    meta = read_meta(path)
    assert "ended" in meta and meta["summary"] == {"x": None}  # NaN -> null, valid JSON
    with pytest.raises(ValueError):
        writer.write_row(1.0, [1.0])
    log = read_log(path)
    assert log["fw_p03"][0] == -1.0 and math.isnan(log["fw_p03"][1])


def test_reader_survives_a_truncated_log(tmp_path, catalog):
    path = tmp_path / "crash.csv.gz"
    write_log(path, [catalog["fw_p03"]], [i * 0.05 for i in range(500)], [[float(i)] for i in range(500)])
    raw = path.read_bytes()
    path.write_bytes(raw[: len(raw) // 2])  # power cut while writing
    log = read_log(path)
    assert 0 < len(log) < 500
    assert log["fw_p03"][-1] == len(log) - 1  # every row kept is complete and correct
    plain = tmp_path / "cut.csv"
    write_log(plain, [catalog["fw_p03"]], [0.0, 0.05], [[1.0], [2.0]])
    plain.write_text(plain.read_text() + "0.100,3")  # no newline: half-written row
    assert len(read_log(plain)) == 2


def test_not_a_log(tmp_path):
    bad = tmp_path / "bad.csv"
    bad.write_text("time,a\n1,2\n")
    with pytest.raises(LogFormatError):
        LogReader(bad)
    with pytest.raises(FileNotFoundError):
        LogReader(tmp_path / "missing.csv")
    assert read_meta(tmp_path / "missing.csv") == {}


# --------------------------------------------------------------------------------------
# tools/export_wide.py
# --------------------------------------------------------------------------------------


def test_export_resamples_interpolates_and_holds(tmp_path, catalog):
    tool = _load_export_tool()
    channels = [catalog["fw_p03"], catalog["inv_state"], catalog["amb_temp"]]
    t = np.arange(0, 2.0001, 0.05)
    fw = 100.0 * t  # a ramp: linear interpolation is exact
    state = np.where(t < 1.0, 2.0, 3.0)
    amb = np.full_like(t, 18.0)
    amb[(t > 0.4) & (t < 1.6)] = np.nan  # 1.2 s dead sensor: must not be bridged
    src = tmp_path / "run.csv.gz"
    write_log(src, channels, t, np.column_stack([fw, state, amb]))

    out = tmp_path / "out.csv"
    rows, cols = tool.export(src, out, channels="fw_*,inv_state,amb_temp", rate_hz=8.0, units=True)
    assert (rows, cols) == (17, 3)
    lines = out.read_text().splitlines()
    assert lines[0] == "t,fw_p03,inv_state,amb_temp"
    assert lines[1] == "s,Pa,enum,°C"
    data = [line.split(",") for line in lines[2:]]
    times = [float(r[0]) for r in data]
    assert times[1] == pytest.approx(0.125)
    assert float(data[1][1]) == pytest.approx(12.5)  # interpolated between 0.10 and 0.15
    assert float(data[7][2]) == 2.0 and times[7] == pytest.approx(0.875)  # held, not 2.x
    assert float(data[8][2]) == 3.0  # t = 1.0
    assert data[8][3] == ""  # inside the gap
    assert float(data[0][3]) == 18.0 and float(data[-1][3]) == 18.0


def test_export_cli_errors_and_defaults(tmp_path, catalog, capsys):
    tool = _load_export_tool()
    src = tmp_path / "run.csv"
    write_log(src, [catalog["fw_p03"]], [0.0, 0.05, 0.1], [[1.0], [2.0], [3.0]])
    assert tool.main([str(src), "--channels", "nope_*"]) == 2
    assert "no channel matches" in capsys.readouterr().err
    assert tool.main([str(src), "--raw-rows", "--nan", "NaN"]) == 0
    out = tmp_path / "run_export.csv"
    assert out.read_text().splitlines() == ["t,fw_p03", "0.000,1", "0.050,2", "0.100,3"]
    assert tool.select_channels(["a", "b_1", "b_2"], "b_*") == ["b_1", "b_2"]
    assert tool.is_discrete("calc_cell_t_max_idx", "-") and tool.is_discrete("sdc_closed", "bool")
    assert not tool.is_discrete("fw_p03", "Pa")
