"""EV powertrain of the virtual car: motor + inverter, accumulator, cooling loop, safety chain.

Energy flow (one physics step)::

    driver pedal → torque request → limits (motor curve, 80 kW accumulator limit, BMS current
    limits, traction control, temperature derating) → shaft torque T at speed ω
      → motor losses  P_m = k_cu·T² + k_fe·ω + k_w·ω²            (copper, iron, windage)
      → AC power      P_ac = T·ω + P_m
      → DC power      P_dc = P_ac / η_inv  (motoring)  or  P_ac · η_inv  (regen)
      → pack current  from P_dc = I·(V_oc − I·R)  (V_oc, R: sums over the 140 cells)
      → every cell:   Thevenin model (OCV, R0, R1‖C1), Coulomb counting, I²R heat
      → heat:         cells → air (cooling grows with speed); motor & inverter → coolant →
                      radiator (rejection grows with airspeed: aero ↔ thermal coupling)

The accumulator is the vectorised form of :class:`aerovolt.core.physics.CellModel` (the same
equations for 140 series groups at once, tested against it), with the per-cell
manufacturing spread of ``vehicle.yaml: accumulator.variation`` drawn from the seed.

Safety (FS rules, SPEC §5.3): the shutdown circuit (SDC) is the series loop AMS ∧ IMD ∧ BSPD.
When it opens, the accumulator isolation relays (AIRs) open, the DC link is discharged, the
TSAL turns green below 60 V and the motor has no torque. The **tractive-system state
machine** restarts (precharge → ready → drive) once the loop is closed again and the car is
stationary. An **APPS implausibility** (the two pedal sensors disagree by > 10 percentage
points for > 100 ms) makes the inverter cut the motor torque (FS T 11.8.9: deactivating the
TS is not required) until the sensors agree again.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass

import numpy as np

from aerovolt.core import physics
from aerovolt.sim.sensors import OrnsteinUhlenbeck

# ---------------------------------------------------------------------------- constants
#: DC cabling + fuse + AIR contact resistance between the pack and the inverter [Ω].
CABLE_RESISTANCE_OHM = 0.010
#: BMS voltage limits used to compute the charge / discharge current limits [V] — a margin
#: inside the hard 4.2 / 2.8 V cell limits so normal driving never trips the AMS.
BMS_CHARGE_V_LIMIT = 4.18
BMS_DISCHARGE_V_LIMIT = 3.00
#: Field-weakening d-axis current at maximum speed [A rms] (adds to the phase current).
FIELD_WEAKENING_A = 80.0
#: Thermal conductance between neighbouring cell groups of a segment (bus bars) [W/K].
CELL_NEIGHBOUR_CONDUCTANCE_W_PER_K = 0.30

#: Tractive-system timing [s]: LV boot before precharge, precharge RC time constant,
#: ready-to-drive delay (FS: ≥ 1 s R2D sound), DC-link discharge time constant, restart delay.
BOOT_DELAY_S = 0.3
PRECHARGE_TAU_S = 0.25
PRECHARGE_DONE_FRACTION = 0.95   # FS rules: AIR+ may close at ≥ 90 % of the pack voltage
READY_TO_DRIVE_S = 1.0
DISCHARGE_TAU_S = 0.35
TSAL_THRESHOLD_V = 60.0
RESTART_DELAY_S = 2.0
#: IMD: healthy insulation, faulted value, trip threshold 500 Ω/V × 588 V, response time.
IMD_HEALTHY_KOHM = 2000.0
IMD_FAULT_KOHM = 150.0
IMD_THRESHOLD_KOHM = 294.0
IMD_RESPONSE_S = 1.5
IMD_TAU_S = 1.0
#: AMS: cell limits must be violated for this long before the AMS opens the SDC; it is
#: reset once everything has been back inside the limits for AMS_RESET_S.
AMS_DEBOUNCE_S = 0.5
AMS_RESET_S = 10.0
#: BSPD: hard braking (front pressure) together with motor power for this long trips it.
BSPD_BRAKE_BAR = 30.0
BSPD_POWER_W = 5000.0
BSPD_TIME_S = 0.5
#: APPS plausibility (FS T 11.8.9).
APPS_MAX_DIFF_PCT = 10.0
APPS_TIME_S = 0.1
#: Inverter over-temperature hysteresis [°C].
INVERTER_FAULT_HYSTERESIS_C = 10.0

#: Cooling loop: share of the coolant (+ cold plates) in the motor/inverter jackets, metal
#: heat capacity of the jackets and of the radiator core, and the share of each component's
#: thermal resistance to the coolant that is convective (h ∝ flow^0.8, Dittus–Boelter): the
#: motor stator relies almost entirely on its water jacket, the inverter's thick aluminium
#: cold plate also spreads heat by conduction.
JACKET_VOLUME_FRACTION = 0.3
JACKET_METAL_J_PER_K = 1000.0
RADIATOR_METAL_J_PER_K = 1500.0
MOTOR_CONVECTIVE_FRACTION = 0.8
INVERTER_CONVECTIVE_FRACTION = 0.3
MIN_FLOW_FRACTION = 0.05   # natural convection in a stagnant jacket


# ============================================================================ motor
class MotorInverter:
    """Torque limits, losses and electrical power of the motor + inverter."""

    def __init__(self, vehicle: Mapping) -> None:
        pt = vehicle["powertrain"]
        m = pt["motor"]
        self.t_peak = float(m["peak_torque_nm"])
        self.p_peak = float(m["peak_power_kw"]) * 1e3
        self.omega_max = float(m["max_speed_rpm"]) * 2.0 * math.pi / 60.0
        self.omega_base = self.p_peak / self.t_peak
        self.k_cu = float(m["losses"]["k_cu_w_per_nm2"])
        self.k_fe = float(m["losses"]["k_iron_w_per_rads"])
        self.k_w = float(m["losses"]["k_windage_w_per_rads2"])
        self.k_t = float(m["torque_constant_nm_per_a"])
        self.motor_derate_c = float(m["derate_start_c"])
        self.motor_max_c = float(m["max_winding_c"])
        inv = pt["inverter"]
        self.eta_inv = float(inv["efficiency"])
        self.inv_derate_c = float(inv["derate_start_c"])
        self.inv_max_c = float(inv["max_c"])

    def envelope(self, omega: float) -> float:
        """Torque/speed curve: ``min(T_peak, P_peak/ω)``, 0 above the maximum speed."""
        w = abs(omega)
        if w >= self.omega_max:
            return 0.0
        return self.t_peak if w * self.t_peak <= self.p_peak else self.p_peak / w

    def iron_loss(self, omega: float) -> float:
        """Iron (hysteresis + eddy) and windage losses [W], present whenever the rotor spins."""
        w = abs(omega)
        return self.k_fe * w + self.k_w * w * w

    def power_limited_torque(self, omega: float, p_dc_max: float) -> float:
        """Largest motoring torque for which the DC power stays ≤ ``p_dc_max``.

        ``(T·ω + k_cu·T² + P_fe)/η_inv = P_max`` → ``k_cu·T² + ω·T + (P_fe − η·P_max) = 0``.
        """
        rest = self.eta_inv * p_dc_max - self.iron_loss(omega)
        if rest <= 0.0:
            return 0.0
        w = abs(omega)
        return (-w + math.sqrt(w * w + 4.0 * self.k_cu * rest)) / (2.0 * self.k_cu)

    def regen_limited_torque(self, omega: float, p_charge_max: float) -> float:
        """Largest regen torque magnitude for which the charge power stays ≤ ``p_charge_max``.

        Generated DC power ``η·(T·ω − k_cu·T² − P_fe)`` grows with T up to ``ω/(2 k_cu)``;
        solve ``k_cu·T² − ω·T + (P_fe + P_max/η) = 0`` for the smaller root.
        """
        w = abs(omega)
        c = self.iron_loss(omega) + p_charge_max / self.eta_inv
        disc = w * w - 4.0 * self.k_cu * c
        if disc <= 0.0:
            return w / (2.0 * self.k_cu)
        return (w - math.sqrt(disc)) / (2.0 * self.k_cu)

    def derate_factor(self, t_winding: float, t_igbt: float) -> float:
        """Torque derating 1 → 0 between the derate start and maximum temperatures."""
        fm = (self.motor_max_c - t_winding) / (self.motor_max_c - self.motor_derate_c)
        fi = (self.inv_max_c - t_igbt) / (self.inv_max_c - self.inv_derate_c)
        return min(1.0, max(0.0, min(fm, fi)))

    def electrical(self, torque: float, omega: float) -> tuple[float, float, float, float]:
        """``(P_dc, P_ac, motor loss, inverter loss)`` [W] for shaft torque ``torque``.

        With zero torque command the inverter draws nothing; the iron/windage losses are
        then taken from the shaft (a small drag) but still heat the motor.
        """
        p_fe = self.iron_loss(omega)
        loss_m = self.k_cu * torque * torque + p_fe
        if torque == 0.0:
            return 0.0, 0.0, loss_m, 0.0
        p_ac = torque * omega + loss_m
        p_dc = p_ac / self.eta_inv if p_ac > 0.0 else p_ac * self.eta_inv
        return p_dc, p_ac, loss_m, abs(p_dc - p_ac)

    def phase_current(self, torque: float, omega: float) -> float:
        """RMS phase current [A]: q-axis current T/k_t plus field weakening above base speed."""
        i_q = abs(torque) / self.k_t
        fw = (abs(omega) - self.omega_base) / (self.omega_max - self.omega_base)
        i_d = FIELD_WEAKENING_A * min(1.0, max(0.0, fw))
        return math.hypot(i_q, i_d)


# ============================================================================ accumulator
class Accumulator:
    """140 series groups, each a Thevenin cell (vectorised ``physics.CellModel``) + thermal.

    Per group *k* (I > 0 = discharge)::

        V_k     = OCV(SoC_k) − I·R0_k − V_rc,k
        V_rc,k ← V_rc,k·e^(−Δt/τ) + I·R1·(1 − e^(−Δt/τ))
        SoC_k  ← SoC_k − I·Δt / (3600·Q_k)
        C_th·dT_k/dt = I²·R0_k + V_rc,k²/R1 − UA(v)·(T_k − T_air) + G_n·(T_k−1 + T_k+1 − 2·T_k)

    ``UA(v) = ua0 + ua1·v`` (segment fans + ram air through the side pods); ``G_n`` couples
    neighbouring groups of the same segment through the bus bars.
    """

    def __init__(self, vehicle: Mapping, rng: np.random.Generator, soc: float, temp_c: float) -> None:
        acc = vehicle["accumulator"]
        self.n = int(acc["series"])
        self.segments = int(acc["segments"])
        self.n_sensors = int(acc["temp_sensors"])
        self.params = physics.CellParams.from_vehicle(vehicle)
        self.table = physics.ocv_table_from_vehicle(vehicle)
        self._tab_soc = np.asarray(self.table.soc)
        self._tab_v = np.asarray(self.table.v)
        var = acc.get("variation", {})
        cap_spread = float(var.get("capacity_pct", 0.0)) / 100.0
        r0_spread = float(var.get("r0_pct", 0.0)) / 100.0
        p = self.params
        self.base_capacity_ah = p.group_capacity_ah * (1.0 + rng.uniform(-cap_spread, cap_spread, self.n))
        self.base_r0 = p.group_r0 * (1.0 + rng.uniform(-r0_spread, r0_spread, self.n))
        self.capacity_ah = self.base_capacity_ah.copy()
        self.r0 = self.base_r0.copy()
        self.r1 = p.group_r1
        self._decay_per_dt: dict[float, float] = {}
        self.v_max = float(acc["cell"]["v_max"])
        self.v_min = float(acc["cell"]["v_min"])
        self.t_max = float(acc["cell"]["max_temp_c"])

        cell = acc["cell"]
        self.c_th = float(cell["mass_kg"]) * float(cell["cp_j_per_kgk"]) * p.parallel
        th = acc["thermal"]
        self.ua0 = float(th["ua0_w_per_k"])
        self.ua1 = float(th["ua1_w_per_k_per_ms"])
        self.g_n = float(th.get("neighbour_w_per_k", CELL_NEIGHBOUR_CONDUCTANCE_W_PER_K))
        per_seg = self.n // self.segments
        # bus-bar links k ↔ k+1 only inside a segment
        self._link = np.array([(k + 1) % per_seg != 0 for k in range(self.n - 1)], dtype=float)
        # temperature sensor j reads the mean of the cells it touches (physics.temp_sensor_cells)
        self.sensor_matrix = np.zeros((self.n_sensors, self.n))
        for j in range(self.n_sensors):
            cells = physics.temp_sensor_cells(j, self.n, self.n_sensors)
            self.sensor_matrix[j, cells.start:cells.stop] = 1.0 / len(cells)

        self.soc = np.full(self.n, float(soc))
        self.v_rc = np.zeros(self.n)
        self.temp = np.full(self.n, float(temp_c))
        self.ocv = np.interp(self.soc, self._tab_soc, self._tab_v)
        self.voltage = self.ocv.copy()
        self.current = 0.0
        self._heat_j = np.zeros(self.n)
        self._ocv_sum = float(self.ocv.sum())
        self._vrc_sum = 0.0
        self._r_sum = float(self.r0.sum())

    # ---- faults ------------------------------------------------------------------------
    def set_r0_factor(self, k: int, factor: float) -> None:
        """Multiply cell ``k``'s ohmic resistance (bad weld) — 1.0 restores it."""
        self.r0[k] = self.base_r0[k] * factor
        self._r_sum = float(self.r0.sum())

    def set_capacity_factor(self, k: int, factor: float) -> None:
        """Scale cell ``k``'s capacity (weak cell) — 1.0 restores it. Its SoC is kept."""
        self.capacity_ah[k] = self.base_capacity_ah[k] * factor

    # ---- electrical -------------------------------------------------------------------
    @property
    def open_circuit_voltage(self) -> float:
        """Σ(OCV − V_rc): the pack voltage at zero current [V]."""
        return self._ocv_sum - self._vrc_sum

    @property
    def resistance(self) -> float:
        """Σ R0 of the string [Ω]."""
        return self._r_sum

    def terminal_voltage(self, current: float) -> float:
        """Pack terminal voltage [V] for ``current`` with the present state."""
        return self.open_circuit_voltage - current * self._r_sum

    def current_for_power(self, p_dc: float, r_extra: float = CABLE_RESISTANCE_OHM) -> float:
        """Pack current [A] that delivers ``p_dc`` [W] behind the extra resistance ``r_extra``.

        ``P = I·(V_oc − I·R)`` → ``I = (V_oc − √(V_oc² − 4·R·P)) / (2·R)`` (the physical,
        smaller root; negative P = charging gives negative I).
        """
        v_oc = self.open_circuit_voltage
        r = self._r_sum + r_extra
        disc = v_oc * v_oc - 4.0 * r * p_dc
        if disc <= 0.0:  # beyond maximum power transfer: deliver what is possible
            return v_oc / (2.0 * r)
        return (v_oc - math.sqrt(disc)) / (2.0 * r)

    def step(self, current: float, dt: float) -> None:
        """Advance every cell by ``dt`` at ``current`` [A] (+ = discharge)."""
        decay = self._decay_per_dt.get(dt)
        if decay is None:
            decay = self._decay_per_dt.setdefault(dt, math.exp(-dt / self.params.tau_s))
        self.v_rc = self.v_rc * decay + (current * self.r1 * (1.0 - decay))
        self.soc -= (current * dt / 3600.0) / self.capacity_ah
        self.ocv = np.interp(self.soc, self._tab_soc, self._tab_v)
        self.voltage = self.ocv - current * self.r0 - self.v_rc
        self._heat_j += (current * current * dt) * self.r0 + (dt / self.r1) * self.v_rc * self.v_rc
        self.current = current
        self._ocv_sum = float(self.ocv.sum())
        self._vrc_sum = float(self.v_rc.sum())

    def current_limits(self) -> tuple[float, float]:
        """BMS ``(discharge, charge)`` current limits [A] that keep every cell inside
        ``BMS_DISCHARGE_V_LIMIT`` … ``BMS_CHARGE_V_LIMIT`` (from each cell's OCV, V_rc, R0)."""
        dcl = float(np.min((self.ocv - self.v_rc - BMS_DISCHARGE_V_LIMIT) / self.r0))
        ccl = float(np.min((BMS_CHARGE_V_LIMIT - self.ocv + self.v_rc) / self.r0))
        return max(dcl, 0.0), max(ccl, 0.0)

    # ---- thermal ----------------------------------------------------------------------
    def thermal_step(self, dt: float, air_speed: float, t_air: float) -> None:
        """Integrate the cell temperatures over ``dt`` with the heat accumulated since the
        last call (explicit Euler; ``dt`` ≪ the ≈ 300 s cell thermal time constant)."""
        ua = self.ua0 + self.ua1 * max(air_speed, 0.0)
        flow = self.g_n * self._link * np.diff(self.temp)  # heat k+1 → k through the bus bar
        net = self._heat_j / dt - ua * (self.temp - t_air)
        net[:-1] += flow
        net[1:] -= flow
        self.temp += net * (dt / self.c_th)
        self._heat_j[:] = 0.0

    def sensor_temperatures(self) -> np.ndarray:
        """True temperature at each of the 60 sensors (mean of the cells it touches)."""
        return self.sensor_matrix @ self.temp

    @property
    def soc_mean(self) -> float:
        return float(self.soc.mean())


# ============================================================================ cooling
class CoolingLoop:
    """Motor winding, inverter IGBT and a two-node water-glycol loop with a radiator.

    Nodes: winding (w), IGBT (i), coolant in the jackets (j), coolant + radiator (r)::

        C_w·dT_w/dt = P_motor − (T_w − T_j)/R_w(flow)
        C_i·dT_i/dt = P_inv   − (T_i − T_j)/R_i(flow)
        C_j·dT_j/dt = (T_w − T_j)/R_w + (T_i − T_j)/R_i − ṁ·c_p·(T_j − T_r)
        C_r·dT_r/dt = ṁ·c_p·(T_j − T_r) − (T_r − T_amb)·(UA0 + UA1·v_air + UA_fan)

    The convective part of R_w, R_i grows as flow^−0.8 (Dittus–Boelter), so a failed pump
    (ṁ → 0) both stops the heat transport *and* insulates the winding: temperatures climb
    much faster. ``cool_temp_in`` (after the radiator, into the inverter) is T_r and
    ``cool_temp_out`` (after the motor) is T_j.
    """

    def __init__(self, vehicle: Mapping, temp_c: float) -> None:
        pt = vehicle["powertrain"]
        c = vehicle["cooling"]
        self.c_w = float(pt["motor"]["thermal"]["c_th_j_per_k"])
        self.r_w = float(pt["motor"]["thermal"]["r_th_k_per_w"])
        self.c_i = float(pt["inverter"]["thermal"]["c_th_j_per_k"])
        self.r_i = float(pt["inverter"]["thermal"]["r_th_k_per_w"])
        cp = float(c["coolant_cp"])
        rho = float(c["coolant_density"])
        volume_m3 = float(c["loop_volume_l"]) / 1000.0
        self.cp = cp
        self.rho = rho
        self.c_j = JACKET_VOLUME_FRACTION * volume_m3 * rho * cp + JACKET_METAL_J_PER_K
        self.c_r = (1.0 - JACKET_VOLUME_FRACTION) * volume_m3 * rho * cp + RADIATOR_METAL_J_PER_K
        self.nominal_flow_lpm = float(c["pump_flow_lpm"])
        rad = c["radiator"]
        self.ua0 = float(rad["ua0_w_per_k"])
        self.ua1 = float(rad["ua1_w_per_k_per_ms"])
        self.ua_fan = float(rad["fan_ua_w_per_k"])
        self.fan_on_c = float(rad["fan_on_c"])
        self.fan_off_c = float(rad["fan_off_c"])
        self.t_winding = self.t_igbt = self.t_jacket = self.t_radiator = float(temp_c)
        self.pump_failed = False
        self.pump_duty = 0.0
        self.fan_on = False
        self.flow_lpm = 0.0
        self._heat_motor_j = 0.0
        self._heat_inv_j = 0.0

    def add_heat(self, motor_w: float, inverter_w: float, dt: float) -> None:
        """Accumulate the motor / inverter losses of one physics step."""
        self._heat_motor_j += motor_w * dt
        self._heat_inv_j += inverter_w * dt

    @staticmethod
    def _thermal_resistance(r_nominal: float, convective: float, flow_fraction: float) -> float:
        """``R(flow) = R_nom·((1 − c) + c·(flow/flow_nom)^−0.8)`` (c = convective share)."""
        f = max(flow_fraction, MIN_FLOW_FRACTION)
        return r_nominal * ((1.0 - convective) + convective * f ** -0.8)

    def step(self, dt: float, pump_on: bool, air_speed: float, t_amb: float) -> None:
        """Integrate the loop over ``dt`` with the heat accumulated since the last call."""
        self.pump_duty = 100.0 if pump_on else 0.0
        self.flow_lpm = 0.0 if self.pump_failed else self.nominal_flow_lpm * self.pump_duty / 100.0
        if self.t_jacket > self.fan_on_c:
            self.fan_on = True
        elif self.t_jacket < self.fan_off_c:
            self.fan_on = False
        flow_fraction = self.flow_lpm / self.nominal_flow_lpm
        r_w = self._thermal_resistance(self.r_w, MOTOR_CONVECTIVE_FRACTION, flow_fraction)
        r_i = self._thermal_resistance(self.r_i, INVERTER_CONVECTIVE_FRACTION, flow_fraction)
        m_cp = self.flow_lpm / 60_000.0 * self.rho * self.cp  # ṁ·c_p [W/K]
        q_w = (self.t_winding - self.t_jacket) / r_w
        q_i = (self.t_igbt - self.t_jacket) / r_i
        q_loop = m_cp * (self.t_jacket - self.t_radiator)
        ua = self.ua0 + self.ua1 * max(air_speed, 0.0) + (self.ua_fan if self.fan_on else 0.0)
        q_rad = (self.t_radiator - t_amb) * ua
        self.t_winding += (self._heat_motor_j / dt - q_w) * dt / self.c_w
        self.t_igbt += (self._heat_inv_j / dt - q_i) * dt / self.c_i
        self.t_jacket += (q_w + q_i - q_loop) * dt / self.c_j
        self.t_radiator += (q_loop - q_rad) * dt / self.c_r
        self._heat_motor_j = self._heat_inv_j = 0.0

    @property
    def fan_duty(self) -> float:
        return 100.0 if self.fan_on else 0.0


# ============================================================================ safety
class TsState:
    """Tractive-system states (``inv_state`` codes for OFF … DRIVE)."""

    OFF = 0
    PRECHARGE = 1
    READY = 2
    DRIVE = 3
    DISCHARGE = 10  # SDC opened: AIRs open, DC link being discharged (inv_state 0)


@dataclass
class SafetyInputs:
    """What the safety logic sees in one step (true physical values + VCU measurements)."""

    pack_ocv: float        # pack voltage at zero current [V]
    car_speed: float       # [m/s]
    apps1: float           # measured pedal sensors [%]
    apps2: float
    brake_press_f: float   # [bar]
    p_dc: float            # inverter DC power [W]


class SafetySystem:
    """Shutdown circuit, AMS / IMD / BSPD / APPS checks and the tractive-system state machine."""

    def __init__(self, rng: np.random.Generator, dt: float) -> None:
        self.state = TsState.OFF
        self.t_state = 0.0
        self.v_dc = 0.0
        self.imd_ok = True
        self.ams_ok = True
        self.bspd_ok = True
        self.apps_ok = True
        self.bms_fault = 0
        self.iso_kohm = IMD_HEALTHY_KOHM
        self._iso_drift = OrnsteinUhlenbeck(0.03, 60.0, dt, rng)
        self._insulation_fault = False
        self._imd_low_s = 0.0
        self._ams_bad_s = 0.0
        self._ams_good_s = 0.0
        self._bspd_s = 0.0
        self._bspd_clear_s = 0.0
        self._apps_bad_s = 0.0
        self._stopped_s = 0.0

    # ---- fault hooks ------------------------------------------------------------------
    def set_insulation_fault(self, on: bool) -> None:
        """Insulation breakdown HV ↔ chassis; clearing it also resets the latched IMD."""
        self._insulation_fault = on
        if not on:
            self.imd_ok = True
            self._imd_low_s = 0.0

    # ---- derived flags ----------------------------------------------------------------
    @property
    def sdc_closed(self) -> bool:
        return self.ams_ok and self.imd_ok and self.bspd_ok

    @property
    def air_closed(self) -> tuple[bool, bool]:
        """``(AIR+, AIR−)``: AIR− closes at precharge start, AIR+ when precharge is done."""
        s = self.state
        return s in (TsState.READY, TsState.DRIVE), s in (TsState.PRECHARGE, TsState.READY, TsState.DRIVE)

    @property
    def precharge_done(self) -> bool:
        return self.state in (TsState.READY, TsState.DRIVE)

    @property
    def tsal_hv(self) -> bool:
        return self.v_dc > TSAL_THRESHOLD_V

    @property
    def driving(self) -> bool:
        """Torque may be produced (TS in DRIVE)."""
        return self.state == TsState.DRIVE

    @property
    def hv_connected(self) -> bool:
        return self.state in (TsState.READY, TsState.DRIVE)

    def bms_state(self) -> int:
        """0 idle, 1 precharge, 2 TS active, 3 fault."""
        if not self.ams_ok:
            return 3
        return {TsState.PRECHARGE: 1, TsState.READY: 2, TsState.DRIVE: 2}.get(self.state, 0)

    # ---- checks -----------------------------------------------------------------------
    def check_cells(self, dt: float, v_min: float, v_max: float, t_max: float,
                    limits: tuple[float, float, float]) -> None:
        """AMS: open the SDC if a cell leaves (v_lo, v_hi, t_hi) for > AMS_DEBOUNCE_S."""
        v_lo, v_hi, t_hi = limits
        code = 1 if v_max > v_hi else 2 if v_min < v_lo else 3 if t_max > t_hi else 0
        if code:
            self._ams_bad_s += dt
            self._ams_good_s = 0.0
            if self._ams_bad_s >= AMS_DEBOUNCE_S and self.ams_ok:
                self.ams_ok = False
                self.bms_fault = code
        else:
            self._ams_bad_s = 0.0
            self._ams_good_s += dt
            if not self.ams_ok and self._ams_good_s >= AMS_RESET_S:
                self.ams_ok = True
                self.bms_fault = 0

    def update(self, dt: float, inp: SafetyInputs) -> None:
        """IMD, BSPD, APPS checks and the tractive-system state machine (one physics step)."""
        # IMD: insulation resistance relaxes towards its (faulted) value; trips if low
        target = IMD_FAULT_KOHM if self._insulation_fault else IMD_HEALTHY_KOHM * (1.0 + self._iso_drift.step())
        self.iso_kohm += (target - self.iso_kohm) * (dt / IMD_TAU_S)
        self._imd_low_s = self._imd_low_s + dt if self.iso_kohm < IMD_THRESHOLD_KOHM else 0.0
        if self._imd_low_s >= IMD_RESPONSE_S:
            self.imd_ok = False
        # BSPD: hard braking while the motor delivers power
        if inp.brake_press_f > BSPD_BRAKE_BAR and inp.p_dc > BSPD_POWER_W:
            self._bspd_s += dt
            if self._bspd_s >= BSPD_TIME_S:
                self.bspd_ok = False
                self._bspd_clear_s = 0.0
        else:
            self._bspd_s = 0.0
            if not self.bspd_ok:
                self._bspd_clear_s += dt
                if self._bspd_clear_s >= AMS_RESET_S:
                    self.bspd_ok = True
        # APPS plausibility: torque cut while the two sensors disagree
        if abs(inp.apps1 - inp.apps2) > APPS_MAX_DIFF_PCT:
            self._apps_bad_s += dt
            if self._apps_bad_s > APPS_TIME_S:
                self.apps_ok = False
        else:
            self._apps_bad_s = 0.0
            self.apps_ok = True
        self._state_machine(dt, inp)

    def _enter(self, state: int) -> None:
        self.state = state
        self.t_state = 0.0

    def _state_machine(self, dt: float, inp: SafetyInputs) -> None:
        self.t_state += dt
        self._stopped_s = self._stopped_s + dt if inp.car_speed < 0.3 else 0.0
        s = self.state
        if s in (TsState.PRECHARGE, TsState.READY, TsState.DRIVE) and not self.sdc_closed:
            self._enter(TsState.DISCHARGE)
            s = self.state
        if s == TsState.OFF:
            if self.sdc_closed and self.t_state >= BOOT_DELAY_S:
                self._enter(TsState.PRECHARGE)
        elif s == TsState.PRECHARGE:
            # DC-link capacitors charge through the precharge resistor
            self.v_dc += (inp.pack_ocv - self.v_dc) * (1.0 - math.exp(-dt / PRECHARGE_TAU_S))
            if self.v_dc >= PRECHARGE_DONE_FRACTION * inp.pack_ocv:
                self._enter(TsState.READY)
        elif s == TsState.READY:
            if self.t_state >= READY_TO_DRIVE_S:
                self._enter(TsState.DRIVE)
        elif s == TsState.DISCHARGE:
            self.v_dc *= math.exp(-dt / DISCHARGE_TAU_S)
            if self.sdc_closed and self._stopped_s >= RESTART_DELAY_S and self.v_dc < TSAL_THRESHOLD_V:
                self._enter(TsState.PRECHARGE)


# ============================================================================ powertrain
@dataclass
class PowertrainOutput:
    """Result of one powertrain step (true values)."""

    torque: float          # shaft torque [Nm] (negative = regen)
    omega: float           # motor speed [rad/s]
    torque_request: float  # driver request after APPS mapping [Nm]
    p_dc: float            # inverter DC power [W]
    p_ac: float
    loss_motor: float
    loss_inv: float
    pack_current: float    # [A] (+ = discharge)
    pack_voltage: float    # terminal voltage [V]
    derate: float          # 1 = full torque available
    regen_force: float     # regen braking force at the rear tyres [N]
    shaft_drag: float      # iron/windage drag torque when the inverter is idle [Nm]


class Powertrain:
    """Motor + inverter + accumulator + cooling + safety, stepped together."""

    def __init__(self, vehicle: Mapping, rng: np.random.Generator, dt: float, *,
                 soc: float, temp_c: float, power_limit_kw: float | None = None,
                 safety_rng: np.random.Generator | None = None) -> None:
        pt = vehicle["powertrain"]
        self.motor = MotorInverter(vehicle)
        self.pack = Accumulator(vehicle, rng, soc, temp_c)
        self.cooling = CoolingLoop(vehicle, temp_c)
        self.safety = SafetySystem(safety_rng if safety_rng is not None else rng, dt)
        self.power_limit_w = 1e3 * float(pt["power_limit_kw"] if power_limit_kw is None else power_limit_kw)
        self.regen_max_w = 1e3 * float(pt["regen_max_kw"])
        self.regen_min_speed = float(pt.get("regen_min_speed_kmh", 5.0)) / 3.6
        self.gear = float(pt["gear_ratio"])
        self.eta_dl = float(pt["driveline_efficiency"])
        self.r_wheel = float(vehicle["wheel_radius_m"])
        self.inverter_fault = 0
        self.dcl, self.ccl = self.pack.current_limits()
        self.bms_soc = soc * 100.0  # BMS Coulomb counter [%], initialised from rest voltage
        self.nominal_capacity_ah = self.pack.params.group_capacity_ah
        self.out = PowertrainOutput(0, 0, 0, 0, 0, 0, 0, 0, self.pack.terminal_voltage(0.0), 1, 0, 0)

    @property
    def derate(self) -> float:
        return self.motor.derate_factor(self.cooling.t_winding, self.cooling.t_igbt)

    def max_drive_power_w(self) -> float:
        """Battery-side power available: the FS 80 kW limit or the BMS discharge limit."""
        return min(self.power_limit_w, self.pack.terminal_voltage(self.dcl) * self.dcl)

    def step(self, dt: float, *, pedal_pct: float, regen_force_request: float, wheel_omega: float,
             traction_torque: float, car_speed: float) -> PowertrainOutput:
        """Torque from the pedal (or regen from the brake request), then power and current.

        ``wheel_omega`` is the rear wheels' angular speed [rad/s]; ``traction_torque`` the
        largest motor torque the rear tyres can transmit (traction control).
        """
        motor = self.motor
        omega = wheel_omega * self.gear
        derate = self.derate
        if self.cooling.t_igbt >= motor.inv_max_c:
            self.inverter_fault = 1
        elif self.inverter_fault and self.cooling.t_igbt < motor.inv_max_c - INVERTER_FAULT_HYSTERESIS_C:
            self.inverter_fault = 0
        can_drive = self.safety.driving and self.safety.apps_ok and not self.inverter_fault
        request = pedal_pct / 100.0 * motor.t_peak
        torque = 0.0
        regen_force = 0.0
        if can_drive and request > 0.0:
            limit = min(motor.envelope(omega) * derate,
                        motor.power_limited_torque(omega, self.max_drive_power_w()),
                        max(traction_torque, 0.0))
            torque = min(request, limit)
        elif can_drive and regen_force_request > 0.0 and car_speed >= self.regen_min_speed:
            p_charge = min(self.regen_max_w, self.pack.terminal_voltage(-self.ccl) * self.ccl)
            t_req = regen_force_request * self.r_wheel * self.eta_dl / self.gear
            t_regen = min(t_req, motor.envelope(omega) * derate, motor.regen_limited_torque(omega, p_charge))
            torque = -max(t_regen, 0.0)
            regen_force = -torque * self.gear / (self.eta_dl * self.r_wheel)
        p_dc, p_ac, loss_m, loss_i = motor.electrical(torque, omega)
        current = self.pack.current_for_power(p_dc) if self.safety.hv_connected else 0.0
        self.pack.step(current, dt)
        self.cooling.add_heat(loss_m, loss_i, dt)
        shaft_drag = motor.iron_loss(omega) / omega if torque == 0.0 and omega > 1.0 else 0.0
        v_pack = self.pack.terminal_voltage(current)
        if self.safety.hv_connected:  # DC link = pack voltage minus the cable/AIR drop
            self.safety.v_dc = v_pack - current * CABLE_RESISTANCE_OHM
        self.out = PowertrainOutput(torque, omega, request, p_dc, p_ac, loss_m, loss_i, current,
                                    v_pack, derate, regen_force, shaft_drag)
        return self.out

    def count_bms_soc(self, measured_current: float, dt: float) -> None:
        """The BMS's own Coulomb counter, driven by its (possibly faulty) current sensor."""
        self.bms_soc -= measured_current * dt / 36.0 / self.nominal_capacity_ah

    def slow_step(self, dt: float, air_speed: float, t_amb: float) -> None:
        """10 Hz housekeeping: thermal models, BMS current limits and the AMS check.

        The AMS judges what it can *measure*: every cell voltage, but temperatures only at
        the 60 sensors (each reads the mean of the cells it touches) - so a hot spot between
        two sensors is seen attenuated, exactly as on the real car."""
        self.pack.thermal_step(dt, air_speed, t_amb)
        self.cooling.step(dt, pump_on=True, air_speed=air_speed, t_amb=t_amb)
        self.dcl, self.ccl = self.pack.current_limits()
        p = self.pack
        self.safety.check_cells(dt, float(p.voltage.min()), float(p.voltage.max()),
                                float(p.sensor_temperatures().max()), (p.v_min, p.v_max, p.t_max))

    def inverter_state(self) -> int:
        """``inv_state`` enum: 0 off, 1 precharge, 2 ready, 3 driving, 4 derating, 5 fault."""
        if self.inverter_fault:
            return 5
        s = self.safety.state
        if s == TsState.DRIVE:
            return 4 if self.derate < 1.0 else 3
        return {TsState.PRECHARGE: 1, TsState.READY: 2}.get(s, 0)
