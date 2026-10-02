"""Injectable faults of the virtual car (SPEC §5.5).

Every fault is a :class:`FaultDef` in the :data:`FAULTS` registry: an id, a title, the
system it belongs to, a description, the alert ids the analysis is expected to raise, and
an **activation hook** — a small function that switches the fault's physical effect on or
off inside the simulator models. Keeping all hooks in this one file makes it easy to see
*where* each fault acts:

=================== ====================================================================
fault               where it acts (physical signature)
=================== ====================================================================
fw_damage_left      aero model: left front-wing station circulation × 0.5 → suction −55 %,
                    front-wing CL·A −25 % (aero balance moves rearwards, L/R asymmetry)
rw_stall            aero model: rear-wing flap separates → aft suction taps collapse to the
                    separated-flow plateau, rear-wing CL·A −40 %, CD·A −10 %
ut_bottoming        suspension: static ride height −12 mm (broken spring / lost packer) →
                    at speed the floor drops below its 12 mm stall height
pitot_blocked       sensor: the pitot's total-pressure hole is blocked → reads ≈ 0 Pa
tap_leak            sensor: leaking tube on rw_p03 → reads 10 % of the true pressure
crosswind_gust      air: 12 m/s gust from the car's left for 20 s → flow yaw
cell_hot            accumulator: cell 47 R0 × 4 (bad weld) → 4× the I²R heat
cell_weak           accumulator: cell 88 capacity × 0.8 → discharges faster, lowest voltage
pump_fail           cooling loop: flow → 0 (duty still 100 %) → winding/IGBT overheat, derating
imd_fault           insulation 2000 → 150 kΩ, the IMD trips → SDC opens, car stops;
                    clearing the fault resets the IMD → tractive-system restart sequence
current_offset      sensor: pack current sensor +3 A offset → Coulomb counting drifts
apps_implausible    sensor: apps2 sticks at 0 % → APPS implausibility → torque cut
=================== ====================================================================

:class:`FaultSet` holds the active state, the activation times and the schedule from the
config (``faults: ["cell_hot@60", ...]``). The engine calls :meth:`FaultSet.due` every
step; :meth:`FaultSet.set` runs the hook and reports whether anything changed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Mapping, Protocol

import numpy as np

from aerovolt.core.model import FaultInfo

#: Cell (series element) index affected by ``cell_hot`` (temperature sensor 20 covers it).
HOT_CELL = 47
#: Internal-resistance multiplier of the badly welded cell.
HOT_CELL_R0_FACTOR = 4.0
#: Cell index affected by ``cell_weak`` and its remaining capacity fraction.
WEAK_CELL = 88
WEAK_CELL_CAPACITY = 0.8
#: Static ride-height loss of ``ut_bottoming`` [mm].
BOTTOMING_DROP_MM = 12.0
#: Side gust of ``crosswind_gust``: speed [m/s] and duration [s].
GUST_SPEED_MS = 12.0
GUST_DURATION_S = 20.0
#: Pack current sensor offset of ``current_offset`` [A].
CURRENT_OFFSET_A = 3.0
#: Leaking tap and the fraction of the true pressure it still reads.
LEAKING_TAP = "rw_p03"
LEAK_FRACTION = 0.10
#: What a blocked pitot reads [Pa]: total and static ports equalise to ≈ 0.
BLOCKED_PITOT_PA = 0.4


class SimTarget(Protocol):
    """What a fault hook may touch: the engine's sub-models (duck-typed, see engine.py)."""

    aero: Any
    air: Any
    chassis: Any
    powertrain: Any
    sensor_faults: SensorFaults

    @property
    def t(self) -> float: ...


Hook = Callable[[SimTarget, bool], None]


@dataclass(frozen=True)
class FaultDef:
    """One injectable fault: identity, expected alerts and its activation hook.

    ``duration_s`` (optional) makes the fault clear itself after that time (a gust).
    """

    id: str
    title: str
    system: str
    description: str
    alerts: tuple[str, ...]
    hook: Hook = field(repr=False, compare=False)
    duration_s: float | None = None


@dataclass
class SensorFaults:
    """Faults that corrupt a *measurement* (the physical car is fine).

    Applied by the engine to the true channel values before the virtual sensors sample them,
    so lag, noise and quantisation still act on the corrupted signal like on a real sensor.
    """

    pitot_blocked: bool = False
    tap_leak: bool = False
    current_offset: bool = False
    apps2_stuck: bool = False

    @property
    def any(self) -> bool:
        return self.pitot_blocked or self.tap_leak or self.current_offset or self.apps2_stuck

    def measured_apps2(self, true_pct: float) -> float:
        """What the second pedal sensor reports [%] (the VCU's plausibility check uses it)."""
        return 0.0 if self.apps2_stuck else true_pct

    def measured_pack_current(self, true_a: float) -> float:
        """What the pack current sensor reports [A] (the BMS Coulomb counter uses it)."""
        return true_a + CURRENT_OFFSET_A if self.current_offset else true_a

    def apply(self, values: np.ndarray, index: Mapping[str, int]) -> None:
        """Corrupt the affected entries of the true-value vector ``values`` in place
        (``index`` maps a channel id to its position)."""
        if self.pitot_blocked:
            values[index["pitot_dp"]] = BLOCKED_PITOT_PA
        if self.tap_leak:
            values[index[LEAKING_TAP]] *= LEAK_FRACTION
        i = index["pack_current"]
        values[i] = self.measured_pack_current(values[i])
        i = index["apps2"]
        values[i] = self.measured_apps2(values[i])


# ---------------------------------------------------------------------------- hooks
def _fw_damage_left(sim: SimTarget, on: bool) -> None:
    sim.aero.fw_damage_left = on


def _rw_stall(sim: SimTarget, on: bool) -> None:
    sim.aero.rw_stall = on


def _ut_bottoming(sim: SimTarget, on: bool) -> None:
    sim.chassis.ride_height_offset_mm = -BOTTOMING_DROP_MM if on else 0.0


def _pitot_blocked(sim: SimTarget, on: bool) -> None:
    sim.sensor_faults.pitot_blocked = on


def _tap_leak(sim: SimTarget, on: bool) -> None:
    sim.sensor_faults.tap_leak = on


def _crosswind_gust(sim: SimTarget, on: bool) -> None:
    if on:  # from the car's left: 90° anticlockwise of its heading
        sim.air.start_side_gust(sim.t, -90.0, GUST_SPEED_MS, GUST_DURATION_S)
    else:
        sim.air.stop_side_gust(sim.t)


def _cell_hot(sim: SimTarget, on: bool) -> None:
    sim.powertrain.pack.set_r0_factor(HOT_CELL, HOT_CELL_R0_FACTOR if on else 1.0)


def _cell_weak(sim: SimTarget, on: bool) -> None:
    sim.powertrain.pack.set_capacity_factor(WEAK_CELL, WEAK_CELL_CAPACITY if on else 1.0)


def _pump_fail(sim: SimTarget, on: bool) -> None:
    sim.powertrain.cooling.pump_failed = on


def _imd_fault(sim: SimTarget, on: bool) -> None:
    sim.powertrain.safety.set_insulation_fault(on)


def _current_offset(sim: SimTarget, on: bool) -> None:
    sim.sensor_faults.current_offset = on


def _apps_implausible(sim: SimTarget, on: bool) -> None:
    sim.sensor_faults.apps2_stuck = on


#: The registry (SPEC §5.5), in dashboard order: aero first, then powertrain.
FAULTS: Mapping[str, FaultDef] = {
    f.id: f
    for f in (
        FaultDef("fw_damage_left", "Front wing damage (left)", "aero",
                 "Left front-wing flap damaged: L station suction −55 %, front-wing CL·A −25 %.",
                 ("aero_fw_asymmetry", "aero_balance_shift"), _fw_damage_left),
        FaultDef("rw_stall", "Rear wing stall", "aero",
                 "Rear-wing flap stall: aft suction taps collapse, rear-wing CL·A −40 %, CD·A −10 %.",
                 ("aero_rw_suction_loss", "aero_balance_shift"), _rw_stall),
        FaultDef("ut_bottoming", "Undertray bottoming", "aero",
                 "Static ride height −12 mm (broken spring/packer): the floor stalls at speed.",
                 ("aero_ut_stall",), _ut_bottoming),
        FaultDef("pitot_blocked", "Pitot blocked", "aero",
                 "Pitot tube blocked (insect/water): the pitot reads ≈ 0 Pa.",
                 ("sensor_pitot_implausible",), _pitot_blocked),
        FaultDef("tap_leak", "Tap tube leak (rw_p03)", "aero",
                 "Leaking tube on rear-wing tap rw_p03: it reads 10 % of the true pressure.",
                 ("sensor_tap_anomaly",), _tap_leak),
        FaultDef("crosswind_gust", "Crosswind gust", "aero",
                 "12 m/s gust from the car's left for 20 s: high flow yaw.",
                 ("aero_high_yaw",), _crosswind_gust, duration_s=GUST_DURATION_S),
        FaultDef("cell_hot", "Hot cell (bad weld)", "powertrain",
                 "Cell 47 internal resistance × 4 (bad weld): it heats 4× faster.",
                 ("bms_cell_temp_outlier", "bms_cell_overtemp"), _cell_hot),
        FaultDef("cell_weak", "Weak cell", "powertrain",
                 "Cell 88 has only 80 % capacity: it discharges faster than the others.",
                 ("bms_cell_voltage_outlier",), _cell_weak),
        FaultDef("pump_fail", "Coolant pump failure", "powertrain",
                 "Coolant flow drops to 0 (pump duty still 100 %): motor and inverter overheat.",
                 ("cooling_no_flow", "motor_temp_high"), _pump_fail),
        FaultDef("imd_fault", "Insulation fault", "powertrain",
                 "Insulation resistance 2000 → 150 kΩ: the IMD trips and opens the shutdown circuit.",
                 ("safety_imd_trip", "safety_sdc_open"), _imd_fault),
        FaultDef("current_offset", "Current sensor offset", "powertrain",
                 "Pack current sensor reads +3 A too much: Coulomb-counted SoC drifts.",
                 ("bms_soc_divergence",), _current_offset),
        FaultDef("apps_implausible", "APPS implausibility", "powertrain",
                 "Accelerator sensor apps2 sticks at 0 %: implausibility → torque cut.",
                 ("safety_apps_implausible",), _apps_implausible),
    )
}


@dataclass
class ScheduledFault:
    """A fault activation planned from the config: ``id`` becomes active at time ``t``."""

    id: str
    t: float


def parse_schedule(items: Iterable[str | Mapping[str, Any]]) -> list[ScheduledFault]:
    """Accept ``"cell_hot@60"`` strings or ``{"id": ..., "t": ...}`` dicts (config.py form)."""
    out = []
    for item in items or ():
        if isinstance(item, str):
            fid, _, t = item.partition("@")
            if not t:
                raise ValueError(f"bad fault schedule {item!r}: expected 'id@seconds'")
            entry = ScheduledFault(fid.strip(), float(t))
        else:
            entry = ScheduledFault(str(item["id"]), float(item.get("t", 0.0)))
        if entry.id not in FAULTS:
            raise KeyError(f"unknown fault {entry.id!r}; available: {', '.join(FAULTS)}")
        out.append(entry)
    return sorted(out, key=lambda f: f.t)


class FaultSet:
    """Active faults of one simulator, their activation times and the schedule."""

    def __init__(self, target: SimTarget, schedule: Iterable[str | Mapping[str, Any]] = ()) -> None:
        self._target = target
        self.active: dict[str, bool] = {fid: False for fid in FAULTS}
        self.since: dict[str, float] = {}
        self.timeline: list[dict[str, Any]] = []  # [{t, id, active}] for logs / tests
        self._pending = parse_schedule(schedule)

    def is_active(self, fault_id: str) -> bool:
        return self.active[fault_id]

    def set(self, fault_id: str, on: bool) -> bool:
        """Activate / clear a fault now; returns ``True`` if its state changed.

        Raises ``KeyError`` for an unknown id (the server maps it to HTTP 404).
        """
        if fault_id not in FAULTS:
            raise KeyError(f"unknown fault {fault_id!r}; available: {', '.join(FAULTS)}")
        on = bool(on)
        if self.active[fault_id] == on:
            return False
        self.active[fault_id] = on
        t = self._target.t
        if on:
            self.since[fault_id] = t
        else:
            self.since.pop(fault_id, None)
        FAULTS[fault_id].hook(self._target, on)
        self.timeline.append({"t": round(t, 3), "id": fault_id, "active": on})
        return True

    def due(self, t: float) -> list[str]:
        """Apply scheduled activations and timed expiries up to ``t``; return changed ids."""
        changed = []
        while self._pending and self._pending[0].t <= t:
            fid = self._pending.pop(0).id
            if self.set(fid, True):
                changed.append(fid)
        for fid, start in list(self.since.items()):
            duration = FAULTS[fid].duration_s
            if duration is not None and t - start >= duration and self.set(fid, False):
                changed.append(fid)
        return changed

    def infos(self) -> list[FaultInfo]:
        """All faults with their state (for ``Source.faults()`` and the dashboard)."""
        return [FaultInfo(f.id, f.title, f.system, f.description, self.active[f.id])
                for f in FAULTS.values()]
