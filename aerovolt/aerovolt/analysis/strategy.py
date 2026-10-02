"""Endurance energy strategy: will the car finish, and at which power limit?

The Formula Student endurance is ~22 km with a fixed accumulator. Running out of energy
means a DNF (did not finish) - the most expensive mistake in the event - while driving too
gently throws away lap time. After every completed lap this module answers:

* **How many laps are left?** ``laps_needed = ceil(distance / lap length)`` minus the laps
  done.
* **How much energy is left?** From the SoC (EKF estimate), above the bottom of the
  usable SoC window: ``E_rem = (SoC - SoC_min) * E_pack`` where ``E_pack`` is the pack's
  nominal energy (capacity x nominal voltage). A reserve (``endurance.reserve_pct`` of the
  usable energy) is kept back for estimation error and the final lap.
* **What would each power limit cost?** The quasi-steady-state lap simulator
  (:func:`aerovolt.sim.lapsim.energy_vs_power`) predicts energy and lap time per lap for
  power limits of 40 ... 80 kW (5 kW steps) with the *nominal* car. Models are never
  perfect (the real driver, tyres, temperatures), so the prediction is **calibrated with
  measurements**: ``scale = measured energy per lap / predicted energy per lap at the
  power limit the car is running now`` (mean of the last three laps). The whole curve is
  multiplied by that factor (lap times likewise by the measured/predicted lap-time ratio).
* **Recommendation:** the highest power limit whose scaled energy per lap, times the laps
  left, fits in the remaining energy minus the reserve. ``energy_short`` is raised when the
  *current* power limit does not fit.

The current power limit is inferred from the highest pack power seen in the last lap
(the accumulator power is capped by the limit), clipped to the configured maximum.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Sequence

import numpy as np

from aerovolt.core.model import LapSummary
from aerovolt.sim import lapsim

NAN = float("nan")

#: Power limits evaluated by the strategy, kW (capped at the car's power limit).
DEFAULT_LIMITS_KW = tuple(range(40, 85, 5))
#: Number of most recent laps averaged for the measured energy per lap.
LAPS_AVERAGED = 3


@dataclass
class StrategyResult:
    """One strategy evaluation (the payload of the ``strategy`` WebSocket event).

    SPEC fields: ``laps_done``, ``laps_needed`` (total laps of the event),
    ``energy_remaining_kwh`` (above the SoC window minimum), ``energy_per_lap_kwh``
    (measured, recent laps), ``recommended_kw``, ``predicted_finish_soc`` (% at the
    recommended limit), ``curve`` (scaled ``[{kw, lap_time, energy_kwh}]``). Extras:
    ``laps_left``, ``laps_possible`` (with the remaining energy minus reserve at the
    measured consumption), ``current_kw``, ``energy_needed_kwh`` (at the current limit),
    ``energy_available_kwh`` (remaining minus reserve), ``energy_short``, ``scale``.
    """

    laps_done: int
    laps_needed: int
    laps_left: int
    energy_remaining_kwh: float
    energy_available_kwh: float
    energy_per_lap_kwh: float
    laps_possible: float
    current_kw: float
    energy_needed_kwh: float
    recommended_kw: float
    predicted_finish_soc: float
    energy_short: bool
    scale: float
    curve: list[dict[str, float]] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        def num(x: float, nd: int) -> float | None:
            return round(float(x), nd) if x is not None and math.isfinite(x) else None

        return {
            "laps_done": int(self.laps_done),
            "laps_needed": int(self.laps_needed),
            "laps_left": int(self.laps_left),
            "energy_remaining_kwh": num(self.energy_remaining_kwh, 3),
            "energy_available_kwh": num(self.energy_available_kwh, 3),
            "energy_per_lap_kwh": num(self.energy_per_lap_kwh, 4),
            "laps_possible": num(self.laps_possible, 2),
            "current_kw": num(self.current_kw, 1),
            "energy_needed_kwh": num(self.energy_needed_kwh, 3),
            "recommended_kw": num(self.recommended_kw, 1),
            "predicted_finish_soc": num(self.predicted_finish_soc, 2),
            "energy_short": bool(self.energy_short),
            "scale": num(self.scale, 3),
            "curve": [{"kw": num(c["kw"], 1), "lap_time": num(c["lap_time"], 3),
                       "energy_kwh": num(c["energy_kwh"], 4)} for c in self.curve],
        }


class EnduranceStrategy:
    """Energy strategy for the endurance event (see the module docstring)."""

    def __init__(self, vehicle: Mapping[str, Any], track: Any = None,
                 limits_kw: Iterable[float] | None = None) -> None:
        self.params = lapsim.VehicleParams.from_dict(vehicle)
        self.track = track
        p_max = self.params.power_limit_kw
        limits = sorted({float(k) for k in (limits_kw or DEFAULT_LIMITS_KW) if 0 < float(k) <= p_max})
        if not limits or limits[-1] < p_max:
            limits.append(p_max)
        self.limits_kw = limits
        self._curve_cache: dict[float, list[dict[str, float]]] = {}

    # ---- energy bookkeeping --------------------------------------------------------

    @property
    def pack_energy_kwh(self) -> float:
        """Nominal pack energy (capacity x nominal voltage), kWh."""
        return self.params.pack_energy_kwh

    @property
    def reserve_kwh(self) -> float:
        """Energy kept in reserve at the finish, kWh (``reserve_pct`` of usable)."""
        return self.params.usable_energy_kwh * self.params.endurance_reserve_pct / 100.0

    def energy_remaining_kwh(self, soc_pct: float) -> float:
        """Energy above the bottom of the usable SoC window, kWh (>= 0)."""
        if not math.isfinite(soc_pct):
            return NAN
        frac = min(soc_pct / 100.0, self.params.soc_window_max) - self.params.soc_window_min
        return max(0.0, frac * self.pack_energy_kwh)

    def laps_total(self, lap_length_m: float | None = None) -> int | None:
        """Laps of the event: ``ceil(endurance distance / lap length)``."""
        length = lap_length_m if lap_length_m else (self.track.length if self.track is not None else None)
        if not length or not math.isfinite(length) or length <= 0:
            return None
        return int(math.ceil(self.params.endurance_distance_km * 1000.0 / length - 1e-9))

    # ---- lap-simulator curve -------------------------------------------------------

    def predicted_curve(self, rho: float = lapsim.RHO_DEFAULT) -> list[dict[str, float]]:
        """Nominal ``[{kw, lap_time, energy_kwh}]`` from the lap simulator (cached per rho)."""
        if self.track is None:
            return []
        key = round(rho if math.isfinite(rho) else lapsim.RHO_DEFAULT, 2)
        if key not in self._curve_cache:
            self._curve_cache[key] = lapsim.energy_vs_power(self.track, self.params, self.limits_kw, rho=key)
        return self._curve_cache[key]

    # ---- evaluation ----------------------------------------------------------------

    def evaluate(self, laps: Sequence[LapSummary], soc_pct: float, current_kw: float | None = None,
                 rho: float = lapsim.RHO_DEFAULT) -> StrategyResult:
        """Strategy after the given completed laps, at the present SoC (%).

        ``current_kw`` is the power limit the car runs (None = the configured limit).
        """
        timed = [lap for lap in laps if math.isfinite(lap.energy_kwh) and lap.energy_kwh > 0
                 and math.isfinite(lap.lap_time) and lap.lap_time > 0]
        recent = timed[-LAPS_AVERAGED:]
        e_lap = float(np.mean([lap.energy_kwh for lap in recent])) if recent else NAN
        t_lap = float(np.mean([lap.lap_time for lap in recent])) if recent else NAN

        lap_length = None if self.track is not None else _median_distance(timed)
        total = self.laps_total(lap_length) or 0
        laps_done = len(laps)
        laps_left = max(0, total - laps_done)

        remaining = self.energy_remaining_kwh(soc_pct)
        available = remaining - self.reserve_kwh if math.isfinite(remaining) else NAN
        laps_possible = max(0.0, available) / e_lap if math.isfinite(available) and e_lap > 0 else NAN

        p_max = self.params.power_limit_kw
        cur = p_max if current_kw is None or not math.isfinite(current_kw) else min(p_max, max(self.limits_kw[0], current_kw))

        nominal = self.predicted_curve(rho)
        scale, time_scale = NAN, NAN
        curve: list[dict[str, float]] = []
        if nominal and math.isfinite(e_lap):
            kws = [c["kw"] for c in nominal]
            e_pred = float(np.interp(cur, kws, [c["energy_kwh"] for c in nominal]))
            t_pred = float(np.interp(cur, kws, [c["lap_time"] for c in nominal]))
            scale = e_lap / e_pred if e_pred > 0 else NAN
            time_scale = t_lap / t_pred if t_pred > 0 else 1.0
            if math.isfinite(scale):
                curve = [{"kw": c["kw"], "lap_time": c["lap_time"] * time_scale,
                          "energy_kwh": c["energy_kwh"] * scale} for c in nominal]

        if curve:
            e_at = lambda kw: float(np.interp(kw, [c["kw"] for c in curve], [c["energy_kwh"] for c in curve]))  # noqa: E731
        else:  # no lap simulator (unknown track): only the measured consumption is known
            e_at = lambda kw: e_lap  # noqa: E731

        needed = e_at(cur) * laps_left if math.isfinite(e_lap) else NAN
        short = bool(laps_left > 0 and math.isfinite(needed) and math.isfinite(available) and needed > available)

        recommended = NAN
        if math.isfinite(available) and math.isfinite(e_lap):
            candidates = [c["kw"] for c in curve] if curve else [cur]
            fitting = [kw for kw in candidates if e_at(kw) * laps_left <= available]
            recommended = max(fitting) if fitting else min(candidates)
        finish_soc = NAN
        if math.isfinite(recommended) and math.isfinite(soc_pct):
            finish_soc = soc_pct - 100.0 * e_at(recommended) * laps_left / self.pack_energy_kwh

        return StrategyResult(
            laps_done=laps_done, laps_needed=total, laps_left=laps_left,
            energy_remaining_kwh=remaining, energy_available_kwh=available,
            energy_per_lap_kwh=e_lap, laps_possible=laps_possible, current_kw=cur,
            energy_needed_kwh=needed, recommended_kw=recommended,
            predicted_finish_soc=finish_soc, energy_short=short, scale=scale, curve=curve,
        )


def _median_distance(laps: Sequence[LapSummary]) -> float | None:
    d = [lap.distance for lap in laps if math.isfinite(lap.distance) and lap.distance > 0]
    return float(np.median(d)) if d else None
