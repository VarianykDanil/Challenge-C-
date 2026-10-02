"""Lap timing from GPS: start/finish-line crossings and per-lap summaries.

How a GPS lap timer works
-------------------------
Each GPS fix (latitude, longitude, 10 Hz) is projected into the flat *track frame*
(metres east / north of ``gps_origin``, :func:`aerovolt.core.geo.latlon_to_xy`). The
timing line is a short **gate** across the track; a lap is completed when the segment
between two consecutive fixes crosses the gate in the direction of travel. The crossing
time is interpolated between the two fixes (linear motion over 0.1 s), so the lap time
is resolved to ~1 ms even though fixes are 100 ms apart.

The gate comes from, in order of preference:

1. ``ctx.track.start_line`` - the start line of the track the session runs on (the
   simulator's track, or the venue named in the config): point + heading, +-5 m wide;
2. a configured gate for a real car on a track AeroVolt does not know::

       laps:
         gate: [[52.07861, -1.01702], [52.07855, -1.01690]]   # two (lat, lon) gate posts
         debounce_s: 5                                        # optional

   The direction of travel is learned from the first crossing; later crossings in the
   opposite direction (e.g. pushing the car back through the pit lane) are ignored.

**Debounce:** after a crossing, further crossings are ignored for ``debounce_s`` (default
5 s; shorter for very short tracks such as the skid pad, whose gate is passed once per
~5 s circle): GPS jitter while the car stands or crawls on the line could otherwise
count several laps.

**Standing start:** if the very first fix is already within 15 m of the gate (the car is on
the grid), lap 1 is timed from that fix - or from the moment the car rolls over the line,
if it was gridded just behind it. Otherwise the time before the first crossing is the
out-lap (lap 0, not summarised). A configured gate learns its direction from the first
crossing, so with a gate there is always an out-lap.

:class:`LapAccumulator` collects per-tick statistics of the lap in progress and turns them
into a :class:`aerovolt.core.model.LapSummary` - averages use valid (finite) samples only.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from aerovolt.core import geo
from aerovolt.core.model import LapSummary

NAN = float("nan")

#: Default minimum time between two counted crossings, s.
DEFAULT_DEBOUNCE_S = 5.0
#: A first fix this close to the gate (m) counts as a standing start of lap 1.
STANDING_START_M = 15.0
#: Lateral tolerance of a configured gate beyond its posts, m (GPS error margin).
GATE_MARGIN_M = 2.0


@dataclass(frozen=True)
class LapEvent:
    """A completed lap: ``lap`` was timed from ``t_start`` to ``t_end``."""

    lap: int
    t_start: float
    t_end: float

    @property
    def lap_time(self) -> float:
        return self.t_end - self.t_start


class _Gate:
    """A timing gate in the track frame: centre ``c``, unit direction of travel ``u``,
    half-width ``w`` (along the gate, either side of the centre)."""

    def __init__(self, cx: float, cy: float, ux: float, uy: float, half_width: float,
                 direction_known: bool) -> None:
        self.cx, self.cy = cx, cy
        self.ux, self.uy = ux, uy
        self.half_width = half_width
        self.direction_known = direction_known

    def along(self, x: float, y: float) -> float:
        """Signed distance of a point in front of the gate (along the travel direction)."""
        return (x - self.cx) * self.ux + (y - self.cy) * self.uy

    def lateral(self, x: float, y: float) -> float:
        """Distance of a point along the gate line from its centre."""
        return abs(-(x - self.cx) * self.uy + (y - self.cy) * self.ux)

    def crossing(self, p0: Sequence[float], p1: Sequence[float]) -> float | None:
        """Fraction ``0 <= f <= 1`` along ``p0 -> p1`` where the gate is crossed, or None.

        With a known direction only forward crossings count (``along`` goes from < 0 to
        >= 0). An unknown direction accepts both and adopts the first one seen.
        """
        d0, d1 = self.along(*p0), self.along(*p1)
        forward = d0 < 0.0 <= d1
        backward = d1 <= 0.0 < d0
        if not (forward or (backward and not self.direction_known)):
            return None
        frac = -d0 / (d1 - d0)
        x = p0[0] + frac * (p1[0] - p0[0])
        y = p0[1] + frac * (p1[1] - p0[1])
        if self.lateral(x, y) > self.half_width:
            return None
        if backward:  # first crossing of a configured gate defines the direction
            self.ux, self.uy = -self.ux, -self.uy
        self.direction_known = True
        return frac


def _gate_from_track(track: Any) -> _Gate:
    line = track.start_line
    h = math.radians(line.heading_deg)
    return _Gate(line.x, line.y, math.sin(h), math.cos(h), line.half_width_m, True)


def _gate_from_posts(posts: Sequence[Sequence[float]], origin: geo.Origin) -> _Gate:
    (lat1, lon1), (lat2, lon2) = posts
    x1, y1 = geo.latlon_to_xy(float(lat1), float(lon1), origin)
    x2, y2 = geo.latlon_to_xy(float(lat2), float(lon2), origin)
    gx, gy = x2 - x1, y2 - y1
    length = math.hypot(gx, gy)
    if length < 0.5:
        raise ValueError("laps.gate posts must be at least 0.5 m apart")
    # Direction of travel: perpendicular to the gate (sign fixed by the first crossing).
    ux, uy = gy / length, -gx / length
    return _Gate(0.5 * (x1 + x2), 0.5 * (y1 + y2), ux, uy, 0.5 * length + GATE_MARGIN_M, False)


def default_debounce_s(track: Any) -> float:
    """5 s, or less on very short tracks: half the track at 20 m/s (skid pad ~2.9 s)."""
    if track is None:
        return DEFAULT_DEBOUNCE_S
    return min(DEFAULT_DEBOUNCE_S, 0.5 * float(track.length) / 20.0)


class LapDetector:
    """Counts laps from GPS fixes (see the module docstring).

    ``lap`` is the lap in progress: 0 = out-lap (before the first crossing), then 1, 2 ...
    ``lap_start`` is the time that lap started (NaN during an untimed out-lap).
    """

    def __init__(self, origin: geo.Origin, track: Any = None,
                 gate: Sequence[Sequence[float]] | None = None, debounce_s: float | None = None) -> None:
        self.origin = origin
        self.track = track
        if track is not None:
            self._gate: _Gate | None = _gate_from_track(track)
        elif gate is not None:
            self._gate = _gate_from_posts(gate, origin)
        else:
            self._gate = None
        self.debounce_s = float(debounce_s) if debounce_s is not None else default_debounce_s(track)
        self.reset()

    @classmethod
    def from_context(cls, vehicle: Mapping[str, Any], track: Any, laps_cfg: Mapping[str, Any] | None) -> LapDetector:
        """Build from ``vehicle.yaml`` (``gps_origin``), ``ctx.track`` and the config's
        optional ``laps: {gate, debounce_s}`` section."""
        cfg = dict(laps_cfg or {})
        origin = vehicle.get("gps_origin") or {"lat": 0.0, "lon": 0.0}
        return cls(origin, track=track, gate=cfg.get("gate"), debounce_s=cfg.get("debounce_s"))

    @property
    def has_gate(self) -> bool:
        return self._gate is not None

    def reset(self) -> None:
        self.lap = 0
        self.lap_start = NAN
        self.position: tuple[float, float] | None = None  # last fix, track frame
        self._t_fix = NAN
        self._last_crossing = -math.inf
        self._fix_key: tuple[float, float, float] | None = None
        self._grid_start = False  # standing start: lap 1 timed from the grid, line not yet passed

    def update(self, t_fix: float, lat: float, lon: float) -> LapEvent | None:
        """Feed one GPS fix (time of the fix, degrees). Returns a :class:`LapEvent` when a
        timed lap is completed. Repeated (sample-and-hold) fixes and NaN are ignored."""
        if not (math.isfinite(t_fix) and math.isfinite(lat) and math.isfinite(lon)):
            return None
        key = (t_fix, lat, lon)
        if key == self._fix_key:
            return None
        self._fix_key = key
        x, y = geo.latlon_to_xy(lat, lon, self.origin)
        p_now = (float(x), float(y))
        p_prev, t_prev = self.position, self._t_fix
        self.position, self._t_fix = p_now, t_fix
        if self._gate is None:
            return None
        if p_prev is None:
            self._standing_start(p_now, t_fix)
            return None
        if not t_fix > t_prev:
            return None
        frac = self._gate.crossing(p_prev, p_now)
        if frac is None:
            if self._grid_start and self._gate.along(*p_now) > STANDING_START_M:
                self._grid_start = False  # started on or past the line: keep the grid time
            return None
        t_cross = t_prev + frac * (t_fix - t_prev)
        if self._grid_start:
            # The car was gridded just behind the line: lap 1 really starts now.
            self._grid_start = False
            self.lap_start = t_cross
            self._last_crossing = t_cross
            return None
        if t_cross - self._last_crossing < self.debounce_s:
            return None
        self._last_crossing = t_cross
        event = LapEvent(self.lap, self.lap_start, t_cross) if self.lap >= 1 else None
        self.lap += 1
        self.lap_start = t_cross
        return event

    def _standing_start(self, p: tuple[float, float], t: float) -> None:
        g = self._gate
        if g is None or not g.direction_known:
            return
        if abs(g.along(*p)) <= STANDING_START_M and g.lateral(*p) <= g.half_width:
            self.lap = 1
            self.lap_start = t
            self._last_crossing = t
            self._grid_start = True

    def lap_distance(self, s_hint: float | None = None) -> float:
        """Distance along the track from the start line at the last fix, m (needs a track)."""
        if self.track is None or self.position is None:
            return NAN
        if s_hint is not None and math.isfinite(s_hint):
            return float(self.track.nearest_s(*self.position, s_hint=s_hint, window_m=50.0))
        return float(self.track.nearest_s(*self.position))


class LapAccumulator:
    """Statistics of the lap in progress, from per-tick samples.

    Feed :meth:`add` every processing tick; :meth:`summary` builds the
    :class:`LapSummary`. Distance is the integral of speed; ``v_avg = distance / lap_time``.
    Aero averages only include ticks flagged ``aero_valid`` (fast enough for the
    coefficients to be updated), all averages skip NaN samples.
    """

    def __init__(self, t_start: float, energy_net_kwh: float, regen_kwh: float) -> None:
        self.t_start = t_start
        self._e0 = energy_net_kwh
        self._r0 = regen_kwh
        self.distance = 0.0
        self.v_max = NAN
        self._sums = {"cla": [0.0, 0], "cda": [0.0, 0], "balance": [0.0, 0]}
        self.cell_t_max = NAN
        self.cell_v_min = NAN
        self.mot_temp_max = NAN

    def add(self, dt: float, speed: float, cla: float, cda: float, balance: float, aero_valid: bool,
            cell_t_max: float, cell_v_min: float, mot_temp: float) -> None:
        if math.isfinite(speed) and dt > 0.0:
            self.distance += speed * dt
            self.v_max = speed if not self.v_max >= speed else self.v_max
        if aero_valid:
            for key, value in (("cla", cla), ("cda", cda), ("balance", balance)):
                if math.isfinite(value):
                    self._sums[key][0] += value
                    self._sums[key][1] += 1
        self.cell_t_max = _nanmax(self.cell_t_max, cell_t_max)
        self.cell_v_min = _nanmin(self.cell_v_min, cell_v_min)
        self.mot_temp_max = _nanmax(self.mot_temp_max, mot_temp)

    def mean(self, key: str) -> float:
        total, count = self._sums[key]
        return total / count if count else NAN

    def summary(self, lap: int, lap_time: float, energy_net_kwh: float, regen_kwh: float,
                distance_m: float | None = None) -> LapSummary:
        """Close the lap. ``energy_kwh`` is the *net* battery energy of the lap (discharge
        minus regen, like ``lapsim.LapResult.energy_kwh``); ``regen_kwh`` the recovered part."""
        distance = self.distance if distance_m is None else distance_m
        return LapSummary(
            lap=lap,
            lap_time=lap_time,
            distance=distance,
            v_avg=distance / lap_time if lap_time > 0 else NAN,
            v_max=self.v_max,
            energy_kwh=energy_net_kwh - self._e0,
            regen_kwh=regen_kwh - self._r0,
            cla_avg=self.mean("cla"),
            cda_avg=self.mean("cda"),
            balance_avg=self.mean("balance"),
            cell_t_max=self.cell_t_max,
            cell_v_min=self.cell_v_min,
            mot_temp_max=self.mot_temp_max,
        )


def _nanmax(a: float, b: float) -> float:
    if not math.isfinite(b):
        return a
    return b if not math.isfinite(a) or b > a else a


def _nanmin(a: float, b: float) -> float:
    if not math.isfinite(b):
        return a
    return b if not math.isfinite(a) or b < a else a
