"""Powertrain model (sim/powertrain_model.py): cells, motor, cooling, safety chain."""

import copy
import math
from pathlib import Path

import numpy as np
import pytest
import yaml

from aerovolt.core import physics
from aerovolt.sim import powertrain_model as pm
from aerovolt.sim.powertrain_model import (
    Accumulator, CoolingLoop, MotorInverter, Powertrain, SafetyInputs, SafetySystem, TsState)

ROOT = Path(__file__).resolve().parents[1]
DT = 0.01


@pytest.fixture(scope="module")
def vehicle():
    return yaml.safe_load((ROOT / "config" / "vehicle.yaml").read_text(encoding="utf-8"))


@pytest.fixture()
def uniform_vehicle(vehicle):
    """The vehicle without manufacturing spread (every cell identical)."""
    v = copy.deepcopy(vehicle)
    v["accumulator"]["variation"] = {"capacity_pct": 0.0, "r0_pct": 0.0}
    return v


def rng(seed=0):
    return np.random.default_rng(seed)


# ---------------------------------------------------------------------------- accumulator
def test_vectorised_cells_match_physics_cell_model(uniform_vehicle):
    """The 140-cell vector model integrates exactly like core.physics.CellModel."""
    pack = Accumulator(uniform_vehicle, rng(), soc=0.9, temp_c=25.0)
    cell = physics.CellModel(physics.CellParams.from_vehicle(uniform_vehicle),
                             physics.ocv_table_from_vehicle(uniform_vehicle), soc=0.9)
    currents = [120.0] * 300 + [-40.0] * 200 + [0.0] * 500
    for i in currents:
        pack.step(i, DT)
        cell.step(i, DT)
    assert pack.soc[0] == pytest.approx(cell.soc, abs=1e-12)
    assert pack.v_rc[17] == pytest.approx(cell.v_rc, abs=1e-12)
    assert pack.voltage[139] == pytest.approx(cell.voltage, abs=1e-9)
    assert pack.terminal_voltage(0.0) == pytest.approx(140 * cell.terminal_voltage(0.0), rel=1e-12)


def test_manufacturing_spread_is_seeded_and_bounded(vehicle):
    a = Accumulator(vehicle, rng(7), soc=1.0, temp_c=25.0)
    b = Accumulator(vehicle, rng(7), soc=1.0, temp_c=25.0)
    c = Accumulator(vehicle, rng(8), soc=1.0, temp_c=25.0)
    assert np.array_equal(a.base_r0, b.base_r0) and not np.array_equal(a.base_r0, c.base_r0)
    nominal = physics.CellParams.from_vehicle(vehicle)
    assert np.all(np.abs(a.base_r0 / nominal.group_r0 - 1.0) <= 0.05 + 1e-12)
    assert np.all(np.abs(a.base_capacity_ah / nominal.group_capacity_ah - 1.0) <= 0.015 + 1e-12)
    assert a.base_r0.std() > 0.0


def test_current_for_power_solves_the_quadratic(vehicle):
    pack = Accumulator(vehicle, rng(), soc=0.8, temp_c=25.0)
    for p in (80_000.0, 15_000.0, -25_000.0):
        i = pack.current_for_power(p, r_extra=0.01)
        v_dc = pack.terminal_voltage(i) - i * 0.01
        assert v_dc * i == pytest.approx(p, rel=1e-9)
        assert math.copysign(1.0, i) == math.copysign(1.0, p)


def test_bms_current_limits_hold_the_cell_voltage_limits(vehicle):
    pack = Accumulator(vehicle, rng(), soc=0.5, temp_c=25.0)
    dcl, ccl = pack.current_limits()
    v_dis = pack.ocv - dcl * pack.r0 - pack.v_rc
    v_chg = pack.ocv + ccl * pack.r0 - pack.v_rc
    assert v_dis.min() == pytest.approx(pm.BMS_DISCHARGE_V_LIMIT, abs=1e-9)
    assert v_chg.max() == pytest.approx(pm.BMS_CHARGE_V_LIMIT, abs=1e-9)
    full = Accumulator(vehicle, rng(), soc=1.0, temp_c=25.0)
    assert full.current_limits()[1] == 0.0  # no regen into a full pack


def test_cell_thermal_response_and_sensor_mapping(uniform_vehicle):
    """Constant current: first-order approach to T_air + Q/UA with τ = C_th/UA
    (Q = I²R0 + V_rc²/R1); the 60 sensors read the mean of the cells they touch."""
    pack = Accumulator(uniform_vehicle, rng(), soc=0.9, temp_c=25.0)
    current, air_speed, t_air, seconds = 60.0, 15.0, 20.0, 400
    for _ in range(seconds * 10):  # 10 Hz thermal steps
        for _ in range(10):
            pack.step(current, DT)
        pack.thermal_step(0.1, air_speed, t_air)
    ua = pack.ua0 + pack.ua1 * air_speed
    heat = current**2 * pack.r0[0] + (current * pack.r1) ** 2 / pack.r1
    decay = math.exp(-seconds * ua / pack.c_th)
    expected = t_air + heat / ua * (1.0 - decay) + (25.0 - t_air) * decay
    assert pack.temp.mean() == pytest.approx(expected, abs=0.3)  # (V_rc builds up in 15 s)
    assert pack.temp.std() < 1e-9  # identical cells, identical temperatures
    pack.temp[:] = np.arange(140.0)
    sensors = pack.sensor_temperatures()
    assert sensors[20] == pytest.approx(np.mean([47.0, 48.0]))
    assert len(sensors) == 60


def test_bus_bar_conduction_conserves_energy_within_segments(uniform_vehicle):
    pack = Accumulator(uniform_vehicle, rng(), soc=0.9, temp_c=25.0)
    pack.ua0 = pack.ua1 = 0.0  # isolate conduction
    pack.temp[47] = 45.0
    pack.temp[28] = 60.0  # first cell of segment 1: no link to cell 27
    before = pack.temp.sum()
    for _ in range(200):
        pack.thermal_step(0.1, 0.0, 20.0)
    assert pack.temp.sum() == pytest.approx(before, rel=1e-12)
    assert pack.temp[46] > 25.0 and pack.temp[48] > 25.0
    assert pack.temp[27] == pytest.approx(25.0)  # segment boundary
    assert pack.temp[29] > 25.0


# ---------------------------------------------------------------------------- motor
def test_motor_envelope_and_power_limit(vehicle):
    m = MotorInverter(vehicle)
    assert m.envelope(100.0) == pytest.approx(220.0)
    assert m.envelope(600.0) == pytest.approx(100_000.0 / 600.0)
    assert m.envelope(m.omega_max + 1.0) == 0.0
    for omega in (150.0, 350.0, 600.0):
        t = m.power_limited_torque(omega, 80_000.0)
        p_dc, p_ac, loss_m, loss_i = m.electrical(t, omega)
        assert p_dc == pytest.approx(80_000.0, rel=1e-9)
        assert p_ac == pytest.approx(t * omega + loss_m)
        assert loss_i == pytest.approx(p_dc * (1 - m.eta_inv), rel=1e-9)


def test_regen_limit_and_power_flow(vehicle):
    m = MotorInverter(vehicle)
    t = m.regen_limited_torque(500.0, 30_000.0)
    p_dc, *_ = m.electrical(-t, 500.0)
    assert p_dc == pytest.approx(-30_000.0, rel=1e-9)
    # zero torque: the inverter draws nothing, the iron loss still heats the motor
    p_dc, p_ac, loss_m, loss_i = m.electrical(0.0, 500.0)
    assert (p_dc, p_ac, loss_i) == (0.0, 0.0, 0.0)
    assert loss_m == pytest.approx(m.iron_loss(500.0))


def test_derating_and_phase_current(vehicle):
    m = MotorInverter(vehicle)
    assert m.derate_factor(80.0, 60.0) == 1.0
    assert m.derate_factor(125.0, 60.0) == pytest.approx(0.5)
    assert m.derate_factor(80.0, 82.5) == pytest.approx(0.5)
    assert m.derate_factor(150.0, 60.0) == 0.0
    assert m.phase_current(150.0, 100.0) == pytest.approx(150.0 / m.k_t)
    assert m.phase_current(0.0, m.omega_max) == pytest.approx(pm.FIELD_WEAKENING_A)


# ---------------------------------------------------------------------------- cooling
def test_cooling_loop_steady_state_energy_balance(vehicle):
    loop = CoolingLoop(vehicle, 20.0)
    for _ in range(30_000):  # 3000 s
        loop.add_heat(1500.0, 500.0, 0.1)
        loop.step(0.1, pump_on=True, air_speed=15.0, t_amb=20.0)
    ua = loop.ua0 + loop.ua1 * 15.0 + (loop.ua_fan if loop.fan_on else 0.0)
    assert (loop.t_radiator - 20.0) * ua == pytest.approx(2000.0, rel=0.01)
    assert loop.t_winding - loop.t_jacket == pytest.approx(1500.0 * loop.r_w, rel=0.01)
    assert loop.t_jacket > loop.t_radiator  # coolant heats up through the jackets
    assert loop.flow_lpm == pytest.approx(8.0)


def test_pump_failure_heats_the_winding_much_faster(vehicle):
    def rise(failed):
        loop = CoolingLoop(vehicle, 40.0)
        loop.pump_failed = failed
        for _ in range(1800):  # 3 minutes at 1 kW motor loss
            loop.add_heat(1000.0, 300.0, 0.1)
            loop.step(0.1, pump_on=True, air_speed=15.0, t_amb=20.0)
        return loop.t_winding - 40.0, loop

    normal, _ = rise(False)
    failed, loop = rise(True)
    assert loop.flow_lpm == 0.0 and loop.pump_duty == 100.0
    assert failed > 1.8 * normal


def test_fan_hysteresis(vehicle):
    loop = CoolingLoop(vehicle, 20.0)
    loop.t_jacket = 51.0
    loop.step(0.1, True, 0.0, 20.0)
    assert loop.fan_on and loop.fan_duty == 100.0
    loop.t_jacket = 47.0
    loop.step(0.1, True, 0.0, 20.0)
    assert loop.fan_on  # still on between the thresholds
    loop.t_jacket = 44.0
    loop.step(0.1, True, 0.0, 20.0)
    assert not loop.fan_on


# ---------------------------------------------------------------------------- safety
def inputs(**kw):
    base = dict(pack_ocv=580.0, car_speed=0.0, apps1=0.0, apps2=0.0, brake_press_f=0.0, p_dc=0.0)
    base.update(kw)
    return SafetyInputs(**base)


def run_safety(s, seconds, **kw):
    for _ in range(round(seconds / DT)):
        s.update(DT, inputs(**kw))


def test_tractive_system_start_sequence():
    """LV boot → precharge (AIR− closed, DC link charging) → AIR+ → ready → drive ≈ 2 s."""
    s = SafetySystem(rng(), DT)
    assert s.state == TsState.OFF and not s.tsal_hv
    run_safety(s, 0.35)
    assert s.state == TsState.PRECHARGE and s.air_closed == (False, True)
    run_safety(s, 0.5)
    assert s.tsal_hv  # > 60 V on the DC link
    run_safety(s, 0.6)
    assert s.state == TsState.READY and s.precharge_done and s.air_closed == (True, True)
    assert s.v_dc >= 0.95 * 580.0
    run_safety(s, 1.0)
    assert s.state == TsState.DRIVE and s.driving


def test_sdc_opening_discharges_and_restarts():
    s = SafetySystem(rng(), DT)
    run_safety(s, 3.0)
    assert s.driving
    s.set_insulation_fault(True)
    run_safety(s, 2.0, car_speed=10.0)
    assert s.imd_ok  # the IMD needs its response time below the threshold
    run_safety(s, 3.0, car_speed=10.0)
    assert not s.imd_ok and not s.sdc_closed and s.state == TsState.DISCHARGE
    assert s.air_closed == (False, False) and not s.precharge_done
    run_safety(s, 1.0, car_speed=5.0)
    assert not s.tsal_hv  # DC link below 60 V within 1 s
    s.set_insulation_fault(False)
    assert s.imd_ok
    run_safety(s, 1.0, car_speed=2.0)
    assert s.state == TsState.DISCHARGE  # waits until the car is stationary
    run_safety(s, 2.5)
    assert s.state in (TsState.PRECHARGE, TsState.READY)
    run_safety(s, 2.0)
    assert s.driving


def test_ams_debounce_trip_and_reset():
    s = SafetySystem(rng(), DT)
    limits = (2.8, 4.2, 60.0)
    s.check_cells(0.4, 3.5, 3.9, 61.0, limits)
    assert s.ams_ok  # only 0.4 s
    s.check_cells(0.2, 3.5, 3.9, 61.0, limits)
    assert not s.ams_ok and s.bms_fault == 3 and s.bms_state() == 3
    s.check_cells(5.0, 3.5, 3.9, 55.0, limits)
    assert not s.ams_ok  # latched until the cells have been fine for AMS_RESET_S
    s.check_cells(pm.AMS_RESET_S, 3.5, 3.9, 55.0, limits)
    assert s.ams_ok and s.bms_fault == 0
    s.check_cells(0.6, 2.7, 3.9, 30.0, limits)
    assert s.bms_fault == 2
    s2 = SafetySystem(rng(), DT)
    s2.check_cells(0.6, 3.5, 4.25, 30.0, limits)
    assert s2.bms_fault == 1


def test_apps_implausibility_latch_needs_100_ms():
    s = SafetySystem(rng(), DT)
    run_safety(s, 0.09, apps1=50.0, apps2=30.0)
    assert s.apps_ok
    run_safety(s, 0.03, apps1=50.0, apps2=30.0)
    assert not s.apps_ok and s.sdc_closed  # torque cut, the SDC stays closed
    run_safety(s, 0.01, apps1=0.0, apps2=0.0)
    assert s.apps_ok


def test_bspd_trips_on_hard_braking_with_power():
    s = SafetySystem(rng(), DT)
    run_safety(s, 0.4, brake_press_f=40.0, p_dc=10_000.0)
    assert s.bspd_ok
    run_safety(s, 0.2, brake_press_f=40.0, p_dc=10_000.0)
    assert not s.bspd_ok and not s.sdc_closed


# ---------------------------------------------------------------------------- powertrain
def started(vehicle, **kw):
    pt = Powertrain(vehicle, rng(), DT, soc=kw.pop("soc", 0.9), temp_c=25.0, **kw)
    for _ in range(300):
        pt.safety.update(DT, inputs(pack_ocv=pt.pack.open_circuit_voltage))
    assert pt.safety.driving
    return pt


def test_powertrain_respects_the_accumulator_power_limit(vehicle):
    pt = started(vehicle)
    out = pt.step(DT, pedal_pct=100.0, regen_force_request=0.0, wheel_omega=110.0,
                  traction_torque=1e9, car_speed=25.0)
    assert out.p_dc == pytest.approx(80_000.0, rel=1e-6)
    # the current is solved on the start-of-step cell state, the reported voltage is the
    # end-of-step value (V_rc has grown a little): agreement within 1 %
    assert out.pack_current * out.pack_voltage == pytest.approx(
        out.p_dc + out.pack_current**2 * pm.CABLE_RESISTANCE_OHM, rel=0.01)
    low = started(vehicle, power_limit_kw=50.0)
    out = low.step(DT, pedal_pct=100.0, regen_force_request=0.0, wheel_omega=110.0,
                   traction_torque=1e9, car_speed=25.0)
    assert out.p_dc == pytest.approx(50_000.0, rel=1e-6)


def test_traction_control_and_torque_cut(vehicle):
    pt = started(vehicle)
    out = pt.step(DT, pedal_pct=100.0, regen_force_request=0.0, wheel_omega=10.0,
                  traction_torque=150.0, car_speed=2.3)
    assert out.torque == pytest.approx(150.0)
    pt.safety.apps_ok = False
    out = pt.step(DT, pedal_pct=100.0, regen_force_request=0.0, wheel_omega=10.0,
                  traction_torque=150.0, car_speed=2.3)
    assert out.torque == 0.0 and out.pack_current == 0.0


def test_regen_on_the_rear_brakes_within_limits(vehicle):
    pt = started(vehicle, soc=0.6)
    out = pt.step(DT, pedal_pct=0.0, regen_force_request=1500.0, wheel_omega=100.0,
                  traction_torque=1e9, car_speed=22.8)
    assert out.torque < 0.0 and out.pack_current < 0.0
    assert -out.p_dc <= 30_000.0 + 1e-6
    assert out.regen_force == pytest.approx(-out.torque * pt.gear / (pt.eta_dl * pt.r_wheel))
    slow = pt.step(DT, pedal_pct=0.0, regen_force_request=1500.0, wheel_omega=5.0,
                   traction_torque=1e9, car_speed=1.0)
    assert slow.torque == 0.0  # FS rules: no regen below 5 km/h
    full = started(vehicle, soc=1.0)
    out = full.step(DT, pedal_pct=0.0, regen_force_request=1500.0, wheel_omega=100.0,
                    traction_torque=1e9, car_speed=22.8)
    assert out.p_dc >= -1.0  # a full pack accepts (almost) no charge


def test_inverter_state_codes(vehicle):
    pt = Powertrain(vehicle, rng(), DT, soc=0.9, temp_c=25.0)
    assert pt.inverter_state() == 0
    for _ in range(50):
        pt.safety.update(DT, inputs())
    assert pt.inverter_state() == 1
    for _ in range(300):
        pt.safety.update(DT, inputs())
    assert pt.inverter_state() == 3
    pt.cooling.t_winding = 120.0
    assert pt.inverter_state() == 4  # derating
    pt.cooling.t_igbt = 95.0
    pt.step(DT, pedal_pct=50.0, regen_force_request=0.0, wheel_omega=50.0, traction_torque=1e9, car_speed=10.0)
    assert pt.inverter_state() == 5 and pt.inverter_fault == 1 and pt.out.torque == 0.0


def test_bms_coulomb_counter(vehicle):
    pt = Powertrain(vehicle, rng(), DT, soc=0.9, temp_c=25.0)
    for _ in range(36_000):  # 360 s at 16 A = 1.6 Ah = 10 % of 16 Ah
        pt.count_bms_soc(16.0, DT)
    assert pt.bms_soc == pytest.approx(80.0, abs=1e-6)
