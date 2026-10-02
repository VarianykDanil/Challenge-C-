"""Aero model (sim/aero_model.py): tap calibration, Cp shapes, forces, wind and faults."""

import math
from pathlib import Path

import numpy as np
import pytest
import yaml

from aerovolt.core import physics
from aerovolt.core.catalog import Catalog
from aerovolt.sim import aero_model
from aerovolt.sim.aero_model import AeroModel, AirModel, Weather, relative_airflow

ROOT = Path(__file__).resolve().parents[1]
STATIONS = ("fw_L", "fw_R", "rw_L", "rw_R", "ut")


@pytest.fixture(scope="module")
def vehicle():
    return yaml.safe_load((ROOT / "config" / "vehicle.yaml").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def catalog(vehicle):
    return Catalog.load(ROOT / "config" / "sensors.yaml", vehicle)


@pytest.fixture()
def aero(vehicle, catalog):
    return AeroModel(vehicle, catalog.taps())


def evaluate(aero, rh=(30.0, 35.0), yaw=0.0, v=25.0, rho=1.2):
    q = 0.5 * rho * v * v
    return aero.evaluate(q, v, yaw, v * math.cos(math.radians(yaw)), *rh)


def tap_cp(aero, state):
    return dict(zip(aero.tap_ids, aero.tap_cp(state)))


# ---------------------------------------------------------------------------- calibration
@pytest.mark.parametrize("rh", [(30, 35), (24, 29), (18, 25), (13, 20), (11, 15), (40, 45)])
@pytest.mark.parametrize("yaw", [0.0, 4.0, -8.0, 12.0])
def test_tap_section_cl_matches_model_within_10_percent(aero, rh, yaw):
    """SPEC §5.3: physics.section_cl of the noise-free taps reproduces the element's model
    section Cl (= CL·A / effective area) within 10 % — over ride heights (ground effect,
    front-wing stall) and flow yaw."""
    state = evaluate(aero, rh, yaw)
    cp = aero.tap_cp(state)
    for station in STATIONS:
        model = aero.model_section_cl(state, station)
        assert aero.station_section_cl(cp, station) == pytest.approx(model, rel=0.10), station


@pytest.mark.parametrize("fault", ["fw_damage_left", "rw_stall"])
def test_tap_section_cl_matches_model_with_faults(aero, fault):
    setattr(aero, fault, True)
    state = evaluate(aero, (27, 32))
    cp = aero.tap_cp(state)
    for station in STATIONS:
        model = aero.model_section_cl(state, station)
        assert aero.station_section_cl(cp, station) == pytest.approx(model, rel=0.10), (fault, station)


def test_floor_stall_taps_match_model(aero):
    """A stalled diffuser (throat below the stall height) still integrates consistently."""
    aero.floor_separated = True
    state = evaluate(aero, (9.0, 13.0))
    assert state.floor_stall > 0.9
    cp = aero.tap_cp(state)
    assert aero.station_section_cl(cp, "ut") == pytest.approx(aero.model_section_cl(state, "ut"), rel=0.10)


def test_reference_condition_reproduces_cla_ref_and_balance(aero, vehicle):
    """At the reference ride heights, no yaw: CL·A = cla_ref and the lap-sim balance."""
    from aerovolt.sim.lapsim import aero_balance_front

    state = evaluate(aero, (30.0, 35.0))
    assert state.cla == pytest.approx(vehicle["aero"]["cla_ref"], rel=1e-6)
    assert state.cda == pytest.approx(vehicle["aero"]["cda_ref"], rel=1e-6)
    balance = state.downforce_f / (state.downforce_f + state.downforce_r)
    assert balance == pytest.approx(aero_balance_front(vehicle), abs=1e-6)
    assert 0.40 <= balance <= 0.50


def test_downforce_at_25_ms(aero):
    """SPEC §5.4: ½·ρ·v²·CL·A ≈ 1350 N at 25 m/s (± 15 %), also with typical aero squat."""
    for rh in ((30.0, 35.0), (25.0, 30.0)):
        state = evaluate(aero, rh, v=25.0)
        assert state.downforce_f + state.downforce_r == pytest.approx(1350.0, rel=0.15)


def test_cp_ranges_at_reference(aero):
    """SPEC §5.4 Cp ranges: suction peaks fw −2.5…−4, rw −2…−3.5, ut throat −1.5…−3,
    pressure side +0.2…+1."""
    cp = tap_cp(aero, evaluate(aero))
    assert -4.0 <= cp["fw_p01"] <= -2.5 and -4.0 <= cp["fw_p07"] <= -2.5
    assert -3.5 <= cp["rw_p01"] <= -2.0 and -3.5 <= cp["rw_p07"] <= -2.0
    assert -3.0 <= cp["ut_p03"] <= -1.5
    for tap in ("fw_p05", "fw_p06", "fw_p11", "fw_p12", "rw_p05", "rw_p06", "rw_p11", "rw_p12"):
        assert 0.2 <= cp[tap] <= 1.0, tap


def test_cp_shapes_are_physical(aero):
    """Suction peak at the leading edge then recovery; undertray minimum at the throat."""
    cp = tap_cp(aero, evaluate(aero))
    for el in ("fw", "rw"):
        suction = [cp[f"{el}_p{i:02d}"] for i in (1, 2, 3, 4)]
        assert suction == sorted(suction)  # monotonic pressure recovery
    floor = [cp[f"ut_p{i:02d}"] for i in range(1, 7)]
    assert int(np.argmin(floor)) == 2  # ut_p03 (fraction 0.40) is the throat
    assert floor[-1] > -0.3            # diffuser exit recovers towards ambient
    assert all(c <= 1.0 for c in cp.values())  # never above stagnation


def test_ground_effect_and_stall(aero):
    """Lower → more downforce (front wing, floor) until the stall heights, then a sharp loss."""
    ref, low, stalled = evaluate(aero, (30, 35)), evaluate(aero, (16, 21)), evaluate(aero, (7, 9))
    assert low.cla_fw > ref.cla_fw and low.cla_ut > ref.cla_ut
    assert stalled.cla_fw < low.cla_fw * 0.75
    assert stalled.cla_ut < low.cla_ut * 0.75
    assert stalled.floor_stall > 0.9


def test_floor_stall_hysteresis(aero):
    """Once separated the floor only reattaches ``FLOOR_REATTACH_MM`` higher."""
    aero.update_floor_state(9.0, 13.0)
    assert aero.floor_separated
    assert evaluate(aero, (15.0, 19.0)).floor_stall > 0.5   # still separated at 15 mm
    aero.update_floor_state(15.0, 19.0)
    assert aero.floor_separated
    aero.update_floor_state(20.0, 25.0)
    assert not aero.floor_separated
    assert evaluate(aero, (15.0, 19.0)).floor_stall < 0.1


def test_yaw_hits_the_windward_station_first(aero):
    """Flow from the left (ψ > 0): the left (windward) stations lose load, the right keep it."""
    state = evaluate(aero, yaw=10.0)
    assert state.station_factor["fw_L"] < state.station_factor["fw_R"] == pytest.approx(1.0)
    assert state.station_factor["rw_L"] < state.station_factor["rw_R"]
    cp = tap_cp(aero, state)
    assert cp["fw_p01"] > cp["fw_p07"]  # less suction on the left
    assert state.cla < evaluate(aero).cla
    assert state.cda > evaluate(aero).cda
    # extreme yaw at walking pace stays bounded (no negative downforce)
    assert evaluate(aero, yaw=80.0, v=2.0).cla > 0.0


def test_fw_damage_signature(aero):
    """Left front-wing suction −55 %, front-wing CL·A −25 %, balance moves rearwards."""
    ref = evaluate(aero)
    aero.fw_damage_left = True
    dmg = evaluate(aero)
    cp_ref, cp_dmg = tap_cp(aero, ref), tap_cp(aero, dmg)
    assert cp_dmg["fw_p01"] / cp_ref["fw_p01"] == pytest.approx(0.45, abs=0.05)
    assert cp_dmg["fw_p07"] == pytest.approx(cp_ref["fw_p07"])
    assert dmg.cla_fw / ref.cla_fw == pytest.approx(0.75, abs=0.01)
    bal = lambda s: s.downforce_f / (s.downforce_f + s.downforce_r)
    assert bal(dmg) < bal(ref) - 0.04


def test_rw_stall_signature(aero):
    """Aft suction taps collapse, rear-wing CL·A −40 %, CD·A −10 %, balance moves forwards."""
    ref = evaluate(aero)
    aero.rw_stall = True
    st = evaluate(aero)
    cp_ref, cp = tap_cp(aero, ref), tap_cp(aero, st)
    for aft in ("rw_p03", "rw_p04", "rw_p09", "rw_p10"):
        assert abs(cp[aft]) < 0.5 * abs(cp_ref[aft])
    assert st.cla_rw / ref.cla_rw == pytest.approx(0.60, abs=0.01)
    induced = 1 + aero_model.INDUCED_DRAG_GAIN * (st.cla / ref.cla - 1)
    assert st.cda / ref.cda == pytest.approx(aero_model.RW_STALL_CDA * induced, rel=1e-6)
    bal = lambda s: s.downforce_f / (s.downforce_f + s.downforce_r)
    assert bal(st) > bal(ref) + 0.05


def test_effective_areas_are_plausible(aero, vehicle):
    """A_eff links section Cl to CL·A: front wing ≈ planform, rear wing (untapped flap)
    larger, floor smaller than the floor area."""
    fw, rw, ut = vehicle["aero"]["front_wing"], vehicle["aero"]["rear_wing"], vehicle["aero"]["undertray"]
    assert aero.area_eff["fw"] == pytest.approx(fw["chord_m"] * fw["span_m"], rel=0.10)
    assert 1.0 < aero.area_eff["rw"] / (rw["chord_m"] * rw["span_m"]) < 1.7
    floor_area = (ut["x_start_m"] - ut["x_end_m"]) * ut["width_m"]
    assert 0.3 < aero.area_eff["ut"] / floor_area < 0.7


def test_wing_load_cell_reads_downforce_plus_inertia(aero):
    state = evaluate(aero)
    assert aero.wing_load(state, "fw", physics.G) == pytest.approx(state.downforce_fw)
    assert aero.wing_load(state, "rw", physics.G + 2.0) == pytest.approx(state.downforce_rw + 2.0 * aero.wing_mass["rw"])


# ---------------------------------------------------------------------------- air
def test_relative_airflow_geometry():
    """Head wind adds to airspeed; wind from the left gives positive yaw."""
    # car heading north at 20 m/s, still air
    v, yaw, ux = relative_airflow(20.0, 0.0, 0.0, 0.0)
    assert (v, yaw, ux) == pytest.approx((20.0, 0.0, 20.0))
    # 5 m/s head wind (air moving south): airspeed 25
    v, yaw, ux = relative_airflow(20.0, 0.0, 0.0, -5.0)
    assert v == pytest.approx(25.0) and ux == pytest.approx(25.0)
    # car heading north, wind from the west (the car's left) blowing east at 5 m/s
    v, yaw, ux = relative_airflow(20.0, 0.0, 5.0, 0.0)
    assert yaw == pytest.approx(math.degrees(math.atan2(5.0, 20.0)))
    assert v == pytest.approx(math.hypot(20.0, 5.0))
    # heading east, wind from the north (the car's left) blowing south
    _, yaw, _ = relative_airflow(20.0, 90.0, 0.0, -5.0)
    assert yaw > 10.0


def test_air_model_wind_statistics_and_density():
    w = Weather(temp_c=15.0, pressure_pa=101325.0, rh_pct=0.0, wind_ms=4.0, wind_dir_deg=270.0)
    air = AirModel(w, np.random.default_rng(5), 0.01)
    assert air.rho == pytest.approx(1.225, abs=0.001)
    speeds, dirs = [], []
    for k in range(60_000):
        air.step(k * 0.01)
        speeds.append(air.speed)
        dirs.append(air.from_deg)
    assert np.mean(speeds) == pytest.approx(4.0, rel=0.1)
    assert 0.3 < np.std(speeds) < 1.5           # gusts
    mean_dir = math.degrees(math.atan2(np.mean(np.sin(np.radians(dirs))), np.mean(np.cos(np.radians(dirs)))))
    assert mean_dir % 360 == pytest.approx(270.0, abs=5.0)
    # from the west → the air moves east
    assert air.wind_e > 0


def test_side_gust_envelope():
    air = AirModel(Weather(wind_ms=0.0), np.random.default_rng(1), 0.01)
    air.start_side_gust(10.0, 90.0, 12.0, 20.0)
    assert air.side_gust_speed(10.5) == pytest.approx(6.0)
    assert air.side_gust_speed(20.0) == pytest.approx(12.0)
    air.step(20.0)
    assert air.wind_e == pytest.approx(-12.0, abs=0.5)  # from the east → blowing west
    assert air.side_gust_speed(31.0) == 0.0
