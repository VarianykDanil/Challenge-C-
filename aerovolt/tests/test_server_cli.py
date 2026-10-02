"""Command line (``python -m aerovolt``): listings, summary table, friendly errors."""

from __future__ import annotations

import socket
from pathlib import Path

import pytest
import yaml

from aerovolt import __main__ as cli
from aerovolt.core.source import MissingDependencyError


def write_cfg(tmp_path: Path, sources: list[dict], **extra) -> str:
    path = tmp_path / "cfg.yaml"
    path.write_text(yaml.safe_dump({"sources": sources, **extra}), encoding="utf-8")
    return str(path)


def test_list_faults_and_tracks(capsys):
    pytest.importorskip("aerovolt.sim.faults")
    from aerovolt.sim.faults import FAULTS

    assert cli.main(["--list-faults", "--list-tracks"]) == 0
    out = capsys.readouterr().out
    for fid in FAULTS:
        assert fid in out
    assert "cell_hot" in out and "bms_cell_temp_outlier" in out
    for name in ("fs_endurance", "skidpad", "acceleration"):
        assert name in out
    assert "closed loop" in out and "open (run)" in out


def test_format_summary_is_a_readable_table():
    summary = {
        "mode": "SIM", "track": "fs_endurance", "duration_s": 130.0, "wall_s": 10.0, "realtime_factor": 13.0,
        "laps": [{"lap": 1, "lap_time": 59.44, "distance": 950.0, "v_avg": 16.0, "v_max": 31.0,
                  "energy_kwh": 0.336, "regen_kwh": 0.037, "cla_avg": 3.62, "cda_avg": 1.29,
                  "balance_avg": 45.6, "cell_t_max": 21.8, "cell_v_min": None, "mot_temp_max": 40.0}],
        "alerts": [{"id": "energy_short", "severity": "warn", "t_start": 63.1, "t_end": None, "active": True,
                    "detail": "At 80 kW the remaining 23 laps need 7.74 kWh"}],
        "faults": [{"t": 60.0, "id": "cell_hot", "active": True, "by": "sim"}],
        "strategy": {"recommended_kw": 55, "laps_needed": 24, "energy_per_lap_kwh": 0.336},
        "final": {"calc_soc_ekf": 95.5, "truth_soc": None},
        "log": "logs/run1.csv.gz",
    }
    text = cli.format_summary(summary)
    assert "13x real time" in text
    assert "59.44" in text and "57.6" in text  # lap time and v_avg in km/h
    assert "energy_short" in text and "active" in text
    assert "cell_hot" in text and "ON" in text
    assert "recommended power limit 55 kW" in text
    assert "truth_soc" in text and "Data log: logs/run1.csv.gz" in text


@pytest.mark.parametrize("argv, message", [
    (["--config", "config/does_not_exist.yaml"], "config file not found"),
    (["--speed", "fast"], "--speed must be a number or 'max'"),
    (["--speed", "-2"], "--speed must be > 0"),
    (["--headless"], "--headless needs --duration"),
])
def test_friendly_errors(argv, message, capsys):
    assert cli.main(argv) == cli.EXIT_USAGE
    err = capsys.readouterr().err
    assert err.startswith("error: ") and message in err
    assert "Traceback" not in err


def test_bad_config_and_missing_replay_file(tmp_path, capsys):
    assert cli.main(["--config", write_cfg(tmp_path, [{"type": "teleport"}])]) == cli.EXIT_USAGE
    assert "unknown source type 'teleport'" in capsys.readouterr().err
    cfg = write_cfg(tmp_path, [{"type": "replay", "file": "logs/missing_for_test.csv.gz"}])
    assert cli.main(["--config", cfg, "--headless"]) == cli.EXIT_USAGE
    assert "replay file not found" in capsys.readouterr().err
    bad_yaml = tmp_path / "bad.yaml"
    bad_yaml.write_text("sources: [{type: sim, speed: zero}]")
    assert cli.main(["--config", str(bad_yaml)]) == cli.EXIT_USAGE
    assert "bad configuration" in capsys.readouterr().err


def test_missing_hardware_package_is_explained(tmp_path, monkeypatch, capsys):
    pytest.importorskip("serial")
    from aerovolt.sources import serial_source

    def no_pyserial(name):
        raise MissingDependencyError("the 'pyserial' package is needed for this source - install the "
                                     "hardware dependencies with: pip install -r requirements-hw.txt")

    monkeypatch.setattr(serial_source, "import_hardware", no_pyserial)
    cfg = write_cfg(tmp_path, [{"type": "serial", "port": "auto"}])
    assert cli.main(["--config", cfg, "--headless", "--duration", "1"]) == cli.EXIT_USAGE
    err = capsys.readouterr().err
    assert "pip install -r requirements-hw.txt" in err and "Traceback" not in err


def test_serial_port_warning(tmp_path):
    from aerovolt.core.config import load_config

    config = load_config(write_cfg(tmp_path, [{"type": "serial", "port": "/dev/aerovolt_missing"},
                                              {"type": "serial", "port": "auto"},
                                              {"type": "serial", "port": "COM5"}]))
    warnings = cli._check_serial_ports(config)
    assert len(warnings) == 1 and "/dev/aerovolt_missing not found" in warnings[0]


def test_port_in_use(tmp_path, capsys):
    pytest.importorskip("serial")
    blocker = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    blocker.bind(("127.0.0.1", 0))
    blocker.listen(1)
    port = blocker.getsockname()[1]
    # A serial source with a missing port is cheap to build and harmless.
    cfg = write_cfg(tmp_path, [{"type": "serial", "port": "/dev/aerovolt_missing"}])
    try:
        assert cli.main(["--config", cfg, "--port", str(port)]) == cli.EXIT_USAGE
    finally:
        blocker.close()
    err = capsys.readouterr().err
    assert f"port {port}" in err and "already in use" in err and f"--port {port + 1}" in err
