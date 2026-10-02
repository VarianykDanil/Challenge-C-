"""Tests for aerovolt.core.config (load_config, overrides, calibration)."""

from pathlib import Path

import pytest
import yaml

from aerovolt.core.config import (
    PROJECT_ROOT,
    Calibration,
    ConfigError,
    load_calibration,
    load_config,
    parse_fault_schedule,
)

ROOT = Path(__file__).resolve().parents[1]

SPEC_VEHICLE = {
    "name": "MMU EV demo car (virtual)",
    "mass_kg": 300,
    "aero": {
        "front_wing": {"chord_m": 0.36, "span_m": 1.40, "le_x_m": 0.80, "z_m": 0.07, "station_y_m": [0.55, -0.55]},
        "rear_wing": {"chord_m": 0.48, "span_m": 1.10, "le_x_m": -1.70, "z_m": 1.05, "station_y_m": [0.25, -0.25]},
        "undertray": {"x_start_m": 0.15, "x_end_m": -1.95, "width_m": 0.90, "z_m": 0.03},
    },
}


@pytest.fixture()
def demo_cfg(tmp_path: Path) -> Path:
    """config/demo.yaml with the vehicle file replaced by the SPEC section 3 geometry."""
    vehicle = tmp_path / "vehicle.yaml"
    vehicle.write_text(yaml.safe_dump(SPEC_VEHICLE), encoding="utf-8")
    data = yaml.safe_load((ROOT / "config" / "demo.yaml").read_text(encoding="utf-8"))
    data["paths"]["vehicle"] = str(vehicle)
    data["paths"]["alerts"] = str(tmp_path / "no_alerts.yaml")
    path = tmp_path / "demo.yaml"
    path.write_text(yaml.safe_dump(data), encoding="utf-8")
    return path


def test_project_root_detection():
    assert PROJECT_ROOT == ROOT
    assert (PROJECT_ROOT / "config" / "sensors.yaml").exists()


def test_demo_config_defaults(demo_cfg):
    cfg = load_config(demo_cfg)
    assert cfg.server.port == 8080 and cfg.server.host == "127.0.0.1" and cfg.server.broadcast_hz == 20
    assert (cfg.processing.process_hz, cfg.processing.snapshot_hz, cfg.processing.history_s) == (20, 20, 300)
    assert cfg.track == "fs_endurance"
    assert cfg.session.log is None
    assert cfg.root == ROOT
    assert cfg.paths.sensors == ROOT / "config" / "sensors.yaml"
    assert cfg.paths.calibration == ROOT / "config" / "calibration.yaml"
    [sim] = cfg.sources
    assert sim["type"] == "sim" and sim["label"] == "Simulator"
    assert sim["track"] == "fs_endurance" and sim["speed"] == 1.0 and sim["seed"] == 42
    assert sim["weather"] == {"temp_c": 18, "pressure_pa": 101325, "rh_pct": 60, "wind_ms": 3.0,
                              "wind_dir_deg": 225}
    assert sim["faults"] == []
    assert cfg.vehicle["name"] == "MMU EV demo car (virtual)"
    assert cfg.catalog["fw_p03"].meta["pos"][1] == pytest.approx(0.55)
    assert cfg.calibration == {}
    assert cfg.alerts == {}  # optional file missing -> empty rules
    assert cfg.headless is False and cfg.duration is None
    assert cfg.source_kinds() == ["sim"]


def test_cli_overrides(demo_cfg):
    cfg = load_config(demo_cfg, {
        "speed": "max", "track": "skidpad", "host": "0.0.0.0", "port": 9001,
        "faults": ["cell_hot@60", "pump_fail@120.5"], "log": "logs/run.csv.gz",
        "headless": True, "duration": 30, "unused": None,
    })
    sim = cfg.sources[0]
    assert sim["speed"] == "max" and sim["track"] == "skidpad" and cfg.track == "skidpad"
    assert sim["faults"] == [{"id": "cell_hot", "t": 60.0}, {"id": "pump_fail", "t": 120.5}]
    assert cfg.server.host == "0.0.0.0" and cfg.server.port == 9001
    assert cfg.session.log == ROOT / "logs" / "run.csv.gz"
    assert cfg.headless is True and cfg.duration == 30.0
    # numeric speed from the CLI arrives as a string
    assert load_config(demo_cfg, {"speed": "4"}).sources[0]["speed"] == 4.0


def test_bad_overrides(demo_cfg):
    with pytest.raises(ConfigError):
        load_config(demo_cfg, {"speed": "fast"})
    with pytest.raises(ConfigError):
        load_config(demo_cfg, {"faults": ["cell_hot@soon"]})


def test_hybrid_sources_and_alerts_file(tmp_path, demo_cfg):
    data = yaml.safe_load(demo_cfg.read_text())
    data["sources"].append({"type": "serial", "port": "auto", "channels": ["fw_p03"]})
    data["sources"][0]["faults"] = ["cell_hot@60", {"id": "pump_fail", "t": 5}]
    alerts = tmp_path / "alerts.yaml"
    alerts.write_text("rules: [{id: x}]\n")
    data["paths"]["alerts"] = str(alerts)
    path = tmp_path / "hybrid.yaml"
    path.write_text(yaml.safe_dump(data))
    cfg = load_config(path, {"faults": ["imd_fault@9"]})
    assert cfg.sources[1]["label"] == "Serial sensor node"
    assert [f["id"] for f in cfg.sources[0]["faults"]] == ["cell_hot", "pump_fail", "imd_fault"]
    assert cfg.alerts == {"rules": [{"id": "x"}]}
    with pytest.raises(ConfigError):  # --fault without a sim source
        data["sources"] = [{"type": "serial"}]
        path.write_text(yaml.safe_dump(data))
        load_config(path, {"faults": ["cell_hot@1"]})


def test_no_config_file_means_sim_only(tmp_path):
    vehicle = tmp_path / "v.yaml"
    vehicle.write_text(yaml.safe_dump(SPEC_VEHICLE))
    cfg_path = tmp_path / "c.yaml"
    cfg_path.write_text(yaml.safe_dump({"paths": {"vehicle": str(vehicle)}}))
    cfg = load_config(cfg_path)
    assert cfg.sources[0]["type"] == "sim" and cfg.sources[0]["weather"]["pressure_pa"] == 101325.0


def test_missing_vehicle_is_a_clear_error(tmp_path):
    cfg_path = tmp_path / "c.yaml"
    cfg_path.write_text(yaml.safe_dump({"paths": {"vehicle": str(tmp_path / "missing.yaml")}}))
    with pytest.raises(ConfigError, match="vehicle file not found"):
        load_config(cfg_path)


def test_fault_schedule_parsing():
    assert parse_fault_schedule("cell_hot@60") == {"id": "cell_hot", "t": 60.0}
    assert parse_fault_schedule("rw_stall") == {"id": "rw_stall", "t": 0.0}
    assert parse_fault_schedule({"id": "x", "t": 3}) == {"id": "x", "t": 3.0}
    for bad in ("@5", "x@-1", "x@nan"):
        with pytest.raises(ConfigError):
            parse_fault_schedule(bad)


def test_calibration_file(tmp_path, demo_cfg):
    assert load_calibration(ROOT / "config" / "calibration.yaml") == {}
    assert load_calibration(tmp_path / "missing.yaml") == {}
    cal_path = tmp_path / "cal.yaml"
    cal_path.write_text("fw_p03: {offset: 3.5, scale: 1.0, note: bench}\nfw_load: {scale: 0.98}\n")
    cal = load_calibration(cal_path)
    assert cal["fw_p03"] == Calibration(3.5, 1.0)
    assert cal["fw_p03"].apply(10.0) == pytest.approx(6.5)
    assert cal["fw_load"].apply(100.0) == pytest.approx(98.0)
    data = yaml.safe_load(demo_cfg.read_text())
    data["paths"]["calibration"] = str(cal_path)
    demo_cfg.write_text(yaml.safe_dump(data))
    assert set(load_config(demo_cfg).calibration) == {"fw_p03", "fw_load"}
    cal_path.write_text("not_a_channel: {offset: 1}\n")
    with pytest.raises(ConfigError, match="unknown channel"):
        load_config(demo_cfg)
