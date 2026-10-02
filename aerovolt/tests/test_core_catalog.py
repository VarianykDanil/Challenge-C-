"""Tests for the channel catalogue (config/sensors.yaml + aerovolt.core.catalog/model)."""

import json
import math
from pathlib import Path

import pytest

from aerovolt.core.catalog import WING_THICKNESS_FRAC, Catalog, CatalogError, expand_entry, tap_position
from aerovolt.core.model import Alert, ChannelDef, FaultInfo, LapSummary, json_value

ROOT = Path(__file__).resolve().parents[1]
SENSORS = ROOT / "config" / "sensors.yaml"

#: Geometry from SPEC section 3 (the tests must not depend on the tuned vehicle.yaml).
SPEC_VEHICLE = {
    "aero": {
        "front_wing": {"chord_m": 0.36, "span_m": 1.40, "le_x_m": 0.80, "z_m": 0.07, "station_y_m": [0.55, -0.55]},
        "rear_wing": {"chord_m": 0.48, "span_m": 1.10, "le_x_m": -1.70, "z_m": 1.05, "station_y_m": [0.25, -0.25]},
        "undertray": {"x_start_m": 0.15, "x_end_m": -1.95, "width_m": 0.90, "z_m": 0.03},
        "pitot": {"x_m": 0.95, "z_m": 0.45},
    }
}

SPEC_RAW_IDS = (
    [f"fw_p{i:02d}" for i in range(1, 13)] + [f"rw_p{i:02d}" for i in range(1, 13)]
    + [f"ut_p{i:02d}" for i in range(1, 9)]
    + ["pitot_dp", "amb_temp", "amb_press", "amb_rh", "probe_yaw", "probe_pitch", "rh_front", "rh_rear",
       "fw_load", "rw_load"]
    + [f"damper_{c}" for c in ("fl", "fr", "rl", "rr")] + [f"pushrod_{c}" for c in ("fl", "fr", "rl", "rr")]
    + ["ax", "ay", "az", "gx", "gy", "gz", "gps_lat", "gps_lon", "gps_speed", "gps_heading"]
    + [f"ws_{c}" for c in ("fl", "fr", "rl", "rr")]
    + ["steer", "apps1", "apps2", "brake_press_f", "brake_press_r"]
    + ["mot_speed", "mot_torque", "mot_winding_temp", "inv_dc_voltage", "inv_dc_current", "inv_phase_current",
       "inv_igbt_temp", "inv_state", "inv_fault", "pack_voltage", "pack_current", "bms_soc", "bms_state",
       "bms_fault"]
    + [f"cell_v_{i:03d}" for i in range(140)] + [f"cell_t_{i:02d}" for i in range(60)]
    + ["cool_temp_in", "cool_temp_out", "cool_flow", "pump_duty", "fan_duty"]
    + ["sdc_closed", "imd_ok", "ams_ok", "bspd_ok", "apps_plaus_ok", "air_pos_closed", "air_neg_closed",
       "precharge_done", "tsal_state", "imd_iso_kohm"]
)
SPEC_TRUTH_IDS = ["truth_speed", "truth_downforce_f", "truth_downforce_r", "truth_drag", "truth_cla",
                  "truth_cda", "truth_soc", "truth_s", "truth_lap", "truth_wind_speed", "truth_wind_dir"]
SPEC_CALC_IDS = (
    ["calc_rho", "calc_q", "calc_airspeed", "calc_yaw"]
    + [f"calc_cp_{t}" for t in SPEC_RAW_IDS[:32]]
    + ["calc_cl_fw_l", "calc_cl_fw_r", "calc_cl_rw_l", "calc_cl_rw_r", "calc_cp_ut_mean", "calc_downforce_f",
       "calc_downforce_r", "calc_downforce", "calc_aero_balance", "calc_cla", "calc_cda", "calc_drag", "calc_ld",
       "calc_fw_asym"]
    + ["calc_pack_power", "calc_mot_power", "calc_inv_eff", "calc_cell_v_min", "calc_cell_v_max",
       "calc_cell_v_delta", "calc_cell_v_min_idx", "calc_cell_t_max", "calc_cell_t_max_idx", "calc_cell_t_mean",
       "calc_soc_cc", "calc_soc_ekf", "calc_energy_used", "calc_energy_regen", "calc_cool_heat",
       "calc_laps_remaining", "calc_laps_needed", "calc_power_limit_rec"]
    + ["calc_lap", "calc_lap_time", "calc_lap_dist"]
)


@pytest.fixture(scope="module")
def catalog() -> Catalog:
    return Catalog.load(SENSORS, SPEC_VEHICLE)


def test_catalog_has_exactly_the_spec_channels(catalog):
    assert sorted(catalog.raw_ids()) == sorted(SPEC_RAW_IDS)
    assert sorted(catalog.truth_ids()) == sorted(SPEC_TRUTH_IDS)
    assert sorted(catalog.calc_ids()) == sorted(SPEC_CALC_IDS)
    assert len(catalog) == len(SPEC_RAW_IDS) + len(SPEC_TRUTH_IDS) + len(SPEC_CALC_IDS)


def test_systems_groups_and_units(catalog):
    assert catalog["fw_p03"].system == "aero" and catalog["fw_p03"].group == "aero.taps"
    assert catalog["damper_fl"].system == "vehicle" and catalog["damper_fl"].unit == "mm"
    assert catalog["cell_v_047"].group == "bms.cell_v" and catalog["cell_v_047"].unit == "V"
    assert catalog["cell_t_20"].unit == "°C" and catalog["cell_t_20"].rate_hz == 2
    assert catalog["calc_cell_v_delta"].unit == "mV"
    assert catalog["imd_iso_kohm"].unit == "kΩ"
    assert catalog.ids(group="bms") == catalog.ids(group="bms.pack") + catalog.ids(group="bms.cell_v") + \
        catalog.ids(group="bms.cell_t")
    assert len(catalog.ids(system="powertrain")) == 229


def test_repeat_expansion_vars_and_meta(catalog):
    ch = catalog["cell_v_139"]
    assert ch.meta == {"index": 139, "segment": 4}
    assert ch.name == "Cell 139 voltage (segment 4)"
    assert catalog["cell_t_59"].meta["segment"] == 4
    assert catalog["calc_cp_ut_p08"].meta["tap"] == "ut_p08"


def test_thresholds_from_requirements(catalog):
    cv = catalog["cell_v_000"]
    assert (cv.warn_lo, cv.crit_lo, cv.warn_hi, cv.crit_hi) == (3.0, 2.8, 4.15, 4.2)
    ct = catalog["cell_t_00"]
    assert (ct.warn_hi, ct.crit_hi) == (55, 60)
    assert (catalog["mot_winding_temp"].warn_hi, catalog["mot_winding_temp"].crit_hi) == (110, 130)
    assert (catalog["inv_igbt_temp"].warn_hi, catalog["inv_igbt_temp"].crit_hi) == (75, 90)
    assert (catalog["cool_temp_out"].warn_hi, catalog["cool_temp_out"].crit_hi) == (55, 65)
    assert catalog["fw_p01"].warn_hi is None


def test_sensor_models_are_realistic(catalog):
    for tap in catalog.taps():
        assert 0.015 <= tap.lag_s <= 0.03
        assert tap.noise == pytest.approx(1.5)
    assert catalog["cell_v_010"].noise == pytest.approx(0.002)
    assert catalog["cell_v_010"].resolution == pytest.approx(0.001)
    assert catalog["cell_t_10"].noise == pytest.approx(0.2)
    assert catalog["cell_t_10"].resolution == pytest.approx(0.1)
    for ch in catalog:
        assert ch.min < ch.max
        if ch.is_raw:
            assert ch.resolution > 0, ch.id


def test_tap_layout_and_positions(catalog):
    taps = catalog.taps()
    assert [t.id for t in taps] == SPEC_RAW_IDS[:32]
    fw = catalog.taps("fw")
    assert [t.meta["x_c"] for t in fw[:6]] == [0.05, 0.20, 0.45, 0.75, 0.10, 0.50]
    assert [t.meta["surface"] for t in fw[:6]] == ["suction"] * 4 + ["pressure"] * 2
    assert {t.meta["station"] for t in fw[6:]} == {"R"}
    # front wing L suction x/c 0.45: x = 0.80 - 0.45*0.36, y = +0.55, z = 0.07 (lower surface)
    assert catalog["fw_p03"].meta["pos"] == pytest.approx([0.80 - 0.45 * 0.36, 0.55, 0.07])
    # rear wing R pressure x/c 0.10: upper surface sits a thickness above the lower one
    assert catalog["rw_p11"].meta["pos"] == pytest.approx(
        [-1.70 - 0.10 * 0.48, -0.25, 1.05 + WING_THICKNESS_FRAC * 0.48])
    # undertray throat on the centreline, left tunnel at y = +0.30
    assert catalog["ut_p03"].meta["pos"] == pytest.approx([0.15 + 0.40 * (-1.95 - 0.15), 0.0, 0.03])
    assert catalog["ut_p07"].meta["pos"] == pytest.approx([0.15 + 0.80 * (-1.95 - 0.15), 0.30, 0.03])
    assert catalog["ut_p08"].meta["pos"][1] == pytest.approx(-0.30)


def test_load_without_vehicle_has_no_positions():
    cat = Catalog.load(SENSORS)
    assert "pos" not in cat["fw_p01"].meta
    with pytest.raises(CatalogError):
        tap_position({"element": "xx", "x_c": 0.1}, SPEC_VEHICLE)


def test_to_json_is_strict_json(catalog):
    data = catalog.to_json()
    text = json.dumps(data, allow_nan=False)
    first = json.loads(text)[0]
    assert set(first) == {"id", "name", "unit", "system", "group", "rate_hz", "min", "max", "noise",
                          "resolution", "lag_s", "warn_lo", "warn_hi", "crit_lo", "crit_hi", "derived", "meta"}
    enum = next(d for d in data if d["id"] == "inv_state")["meta"]["enum"]
    assert enum["3"] == "driving"


def test_index_and_container_protocol(catalog):
    assert catalog.index(catalog.ids()[5]) == 5
    assert "fw_p01" in catalog and "nope" not in catalog
    assert catalog.get("nope") is None
    assert list(catalog)[0].id == "fw_p01"


def _mini(channels, defaults=None):
    return {"sections": [{"defaults": defaults or {}, "channels": channels}]}


BASE = {"unit": "V", "system": "powertrain", "group": "g", "rate_hz": 1, "min": 0, "max": 1}


@pytest.mark.parametrize("bad", [
    [{"id": "calc_x", "name": "x", **BASE}],  # calc prefix but not system calc
    [{"id": "x", "name": "x", **{**BASE, "system": "calc"}}],  # system calc without prefix
    [{"id": "truth_x", "name": "x", **BASE}],  # truth prefix, wrong system
    [{"id": "a", "name": "a", **BASE}, {"id": "a", "name": "b", **BASE}],  # duplicate
    [{"id": "a", "name": "a", **{**BASE, "min": 2}}],  # min > max
    [{"id": "a", "name": "a", **BASE, "colour": "red"}],  # unknown field
    [{"id": "a", **BASE}],  # missing name
    [{"id": "Bad-Id", "name": "a", **BASE}],  # not snake_case
])
def test_validation_errors(bad):
    with pytest.raises(CatalogError):
        Catalog.from_dict(_mini(bad))


def test_repeat_rejects_code_in_vars():
    with pytest.raises(CatalogError):
        expand_entry({"id": "c{i}", "count": 2, "vars": {"x": "__import__('os')"}})


# ---------------------------------------------------------------------------- model


def test_json_value_rounding_and_nan():
    assert json_value(float("nan")) is None
    assert json_value(float("inf")) is None
    assert json_value(None) is None
    assert json_value(3.91234567, 0.001) == 3.9123
    assert json_value(-523.1234, 0.1) == -523.12
    assert json_value(52.07861234567, 1e-7) == 52.07861235
    assert json_value(1234.5678) == 1235.0  # 4 significant figures
    assert json_value(0.00123456) == 0.001235


def test_model_to_json():
    alert = Alert("bms_cell_overtemp", "bms_cell_overtemp", "critical", "Cell over-temperature",
                  "cell 47 at 61.2 °C", ["cell_t_20"], 512.3)
    j = alert.to_json()
    assert j["t_end"] is None and j["active"] is True and j["channels"] == ["cell_t_20"]
    lap = LapSummary(3, 61.234, 1001.2, 16.3, 31.0, 0.35, 0.05, 3.5, 1.3, 45.0, 41.2, 3.81, float("nan"))
    lj = lap.to_json()
    assert lj["lap"] == 3 and lj["mot_temp_max"] is None
    json.dumps(lj, allow_nan=False)
    assert FaultInfo("cell_hot", "Hot cell", "powertrain", "R0 x4").to_json()["active"] is False
    ch = ChannelDef("x", "X", "V", "powertrain", "g", 1.0, 0.0, 1.0)
    assert ch.is_raw and not ch.is_tap
    assert hash(ch)  # frozen dataclass stays hashable despite the meta dict
    assert not math.isnan(ch.max)
