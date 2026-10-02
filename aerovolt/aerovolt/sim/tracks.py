"""Race tracks: centrelines in the flat *track frame* (x east, y north, metres).

A :class:`Track` is the racing centreline sampled every ≈ 0.5 m with

* ``s``       distance along the centreline from the start line [m]
* ``x, y``    position in the track frame [m] (see :mod:`aerovolt.core.geo`)
* ``kappa``   signed curvature κ = dθ/ds [1/m]; positive = turning **left**; radius R = 1/|κ|
* ``heading`` compass heading [deg] (0 = north, 90 = east, clockwise), as reported by GPS

How the tracks are built
------------------------
Real circuits are designed as a *curvature program*: straights, constant-radius arcs and
**clothoid** (Euler-spiral) transitions in which the curvature changes linearly with distance,
so the steering angle — and the car's lateral acceleration — builds up smoothly instead of
jumping. Given κ(s), the centreline follows by integration::

    θ(s) = θ0 + ∫ κ ds            (maths angle of the tangent, from +x, anticlockwise)
    x(s) = ∫ cos θ ds,  y(s) = ∫ sin θ ds

The built-in Formula Student tracks are written this way (``_CurvatureProgram``), which gives
exact control over corner radii, straight lengths and the slalom cone spacing — exactly the
things the FS rules constrain. A closed loop must return to its start with the same
heading: the total turning angle is forced to ±360° by computing the last corner's angle,
and the position gap is closed by a small Newton solve on the lengths of two straights.

Custom tracks (for example a circuit surveyed with GPS on the day) can instead be built from
a handful of control points with :meth:`Track.from_control_points`, which fits a **periodic
cubic spline** (C² continuous, so curvature is continuous round the loop).

Registry: :data:`TRACKS` maps a name to a builder; :func:`get_track` returns a cached,
read-only :class:`Track`.
"""

from __future__ import annotations

import functools
import math
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field

import numpy as np

from aerovolt.core import geo

#: Target spacing of the resampled centreline [m].
DEFAULT_DS_M = 0.5
#: Step used to integrate the curvature program [m] (fine, then resampled to ``DEFAULT_DS_M``).
_INTEGRATION_DS_M = 0.05
#: Maximum number of points in ``Track.to_json`` (keeps the hello message small).
JSON_MAX_POINTS = 1500
#: Half-width of the start/finish timing gate [m]: track width (≈ 3–4 m) plus GPS error margin.
START_GATE_HALF_WIDTH_M = 5.0


@dataclass(frozen=True)
class StartLine:
    """Start/finish timing line: a gate across the track at distance ``s``.

    The gate passes through ``(x, y)`` perpendicular to the direction of travel
    ``heading_deg`` (compass) and extends ``half_width_m`` either side of the centreline.
    """

    x: float
    y: float
    heading_deg: float
    s: float = 0.0
    half_width_m: float = START_GATE_HALF_WIDTH_M


@dataclass(frozen=True)
class TrackFeature:
    """A named section of the track (used for tests, documentation and the track map)."""

    kind: str  # 'straight' | 'hairpin' | 'corner' | 'sweeper' | 'slalom' | 'chicane'
    label: str
    s_start: float
    s_end: float


@dataclass(frozen=True, eq=False)
class Track:
    """A sampled race-track centreline (see module docstring for the frame and sign rules).

    For a **closed** track the arrays hold ``N`` points spaced ``length / N`` apart and the
    last point connects back to the first (the start point is not repeated). For an **open**
    track (acceleration) the arrays run from ``s = 0`` to ``s = length`` inclusive.
    Arrays are read-only because tracks are shared through the :func:`get_track` cache.
    """

    name: str
    closed: bool
    x: np.ndarray
    y: np.ndarray
    s: np.ndarray
    kappa: np.ndarray
    heading: np.ndarray
    length: float
    start_line: StartLine
    finish_s: float | None = None
    features: tuple[TrackFeature, ...] = field(default_factory=tuple)

    # ------------------------------------------------------------------ constructors
    @classmethod
    def from_samples(
        cls,
        name: str,
        closed: bool,
        s_fine: np.ndarray,
        x_fine: np.ndarray,
        y_fine: np.ndarray,
        theta_fine: np.ndarray,
        kappa_fine: np.ndarray,
        ds: float = DEFAULT_DS_M,
        finish_s: float | None = None,
        features: Sequence[TrackFeature] = (),
    ) -> Track:
        """Resample a finely sampled centreline to a uniform spacing close to ``ds``.

        ``theta_fine`` is the *continuous* (unwrapped) maths angle of the tangent [rad].
        For a closed track the fine arrays must include the closing point at ``s = length``.
        """
        length = float(s_fine[-1] - s_fine[0])
        n = max(int(round(length / ds)), 2)
        if closed:
            s_new = np.arange(n) * (length / n)
        else:
            s_new = np.linspace(0.0, length, n + 1)
        s_rel = s_fine - s_fine[0]
        x = np.interp(s_new, s_rel, x_fine)
        y = np.interp(s_new, s_rel, y_fine)
        theta = np.interp(s_new, s_rel, theta_fine)
        kappa = np.interp(s_new, s_rel, kappa_fine)
        heading = _compass_from_theta(theta)
        start = StartLine(x=float(x[0]), y=float(y[0]), heading_deg=float(heading[0]), s=0.0)
        arrays = [x, y, s_new, kappa, heading]
        for arr in arrays:
            arr.setflags(write=False)
        return cls(
            name=name,
            closed=closed,
            x=x,
            y=y,
            s=s_new,
            kappa=kappa,
            heading=heading,
            length=length,
            start_line=start,
            finish_s=finish_s,
            features=tuple(features),
        )

    @classmethod
    def from_control_points(
        cls, name: str, points: Sequence[Sequence[float]], ds: float = DEFAULT_DS_M
    ) -> Track:
        """Build a **closed** track through ``points`` with a periodic cubic spline.

        The curve is parametrised by cumulative chord length ``t`` and each coordinate is an
        interpolating cubic spline whose first and second derivatives match where the loop
        closes (periodic boundary conditions → C² everywhere). Curvature comes from the
        analytic derivatives::

            κ = (x′ y″ − y′ x″) / (x′² + y′²)^(3/2)

        The spline is evaluated finely, true arc length is accumulated, and the result is
        resampled to uniform ``ds``. The first control point is the start/finish line and the
        direction of travel is the order of the points.
        """
        pts = np.asarray(points, dtype=float)
        if pts.ndim != 2 or pts.shape[1] != 2 or len(pts) < 4:
            raise ValueError("need at least 4 control points as [[x, y], ...]")
        if np.hypot(*(pts[0] - pts[-1])) < 1e-9:
            pts = pts[:-1]  # the loop closes by itself; do not repeat the first point
        spline = _PeriodicCubicSpline(pts)
        samples_per_unit = 1.0 / _INTEGRATION_DS_M
        n_fine = max(int(spline.period * samples_per_unit), 400)
        t = np.linspace(0.0, spline.period, n_fine + 1)
        (x, y), (dx, dy), (ddx, ddy) = spline.evaluate(t)
        speed = np.hypot(dx, dy)
        seg = 0.5 * (speed[1:] + speed[:-1]) * np.diff(t)
        s_fine = np.concatenate(([0.0], np.cumsum(seg)))
        kappa = (dx * ddy - dy * ddx) / speed**3
        theta = np.unwrap(np.arctan2(dy, dx))
        return cls.from_samples(name, True, s_fine, x, y, theta, kappa, ds=ds)

    # ------------------------------------------------------------------ queries
    @property
    def ds(self) -> float:
        """Uniform spacing between samples [m]."""
        return float(self.s[1] - self.s[0])

    def position_at(self, s: float | np.ndarray) -> tuple:
        """Interpolated ``(x, y, heading_deg)`` at distance ``s`` along the track.

        Closed tracks wrap ``s`` modulo the lap length; open tracks clamp to ``[0, length]``.
        Heading is interpolated on the unwrapped angle, so it is correct across north
        (359° → 1°). Accepts a float or an array (returns arrays of the same shape).
        """
        s_q = np.asarray(s, dtype=float)
        xs, ys, ss, theta = self._closed_arrays()
        s_q = np.mod(s_q, self.length) if self.closed else np.clip(s_q, 0.0, self.length)
        x = np.interp(s_q, ss, xs)
        y = np.interp(s_q, ss, ys)
        heading = _compass_from_theta(np.interp(s_q, ss, theta))
        if np.ndim(s_q) == 0:
            return float(x), float(y), float(heading)
        return x, y, heading

    def nearest_s(
        self, x: float, y: float, s_hint: float | None = None, window_m: float | None = None
    ) -> float:
        """Distance along the track of the point on the centreline closest to ``(x, y)``.

        Projects the point onto every centreline segment (vectorised) and keeps the closest
        projection. With ``s_hint`` and ``window_m`` only segments within ±``window_m`` of
        the hint are searched — use this when tracking a moving car so that the projection
        cannot jump to a different part of the track where it passes close by (for example
        the crossover of the skid-pad figure of eight).
        """
        xs, ys, ss, _ = self._closed_arrays()
        x0, y0, s0 = xs[:-1], ys[:-1], ss[:-1]
        dx, dy = np.diff(xs), np.diff(ys)
        seg_len2 = dx * dx + dy * dy
        if s_hint is not None and window_m is not None:
            d = np.abs(s0 - s_hint)
            if self.closed:
                d = np.minimum(d, self.length - d)
            mask = d <= window_m
            if np.any(mask):
                x0, y0, s0, dx, dy, seg_len2 = (
                    a[mask] for a in (x0, y0, s0, dx, dy, seg_len2)
                )
        u = ((x - x0) * dx + (y - y0) * dy) / seg_len2
        u = np.clip(u, 0.0, 1.0)
        dist2 = (x0 + u * dx - x) ** 2 + (y0 + u * dy - y) ** 2
        i = int(np.argmin(dist2))
        s_val = float(s0[i] + u[i] * math.sqrt(seg_len2[i]))
        return s_val % self.length if self.closed else s_val

    def crossed_start_line(
        self, p_prev: Sequence[float], p_now: Sequence[float]
    ) -> bool:
        """True if the move ``p_prev → p_now`` (track-frame points) crosses the start gate
        in the direction of travel.

        With ``t`` the unit vector of the start heading and ``c`` the gate centre, the
        signed along-track distance of a point is ``d = (p − c)·t``. A forward crossing
        needs ``d_prev < 0 ≤ d_now``; the crossing point (linear interpolation) must also
        lie within ``half_width_m`` of the centreline, so other parts of the circuit that
        cross the gate's infinite extension are ignored.
        """
        line = self.start_line
        h = math.radians(line.heading_deg)
        tx, ty = math.sin(h), math.cos(h)  # compass heading → (east, north) unit vector
        px, py = float(p_prev[0]) - line.x, float(p_prev[1]) - line.y
        qx, qy = float(p_now[0]) - line.x, float(p_now[1]) - line.y
        d_prev = px * tx + py * ty
        d_now = qx * tx + qy * ty
        if not (d_prev < 0.0 <= d_now):
            return False
        frac = -d_prev / (d_now - d_prev)
        cx, cy = px + frac * (qx - px), py + frac * (qy - py)
        lateral = abs(-cx * ty + cy * tx)
        return lateral <= line.half_width_m

    def to_json(self, origin: geo.Origin) -> dict:
        """JSON-ready description for the web track map (SPEC §5.1), ≤ 1500 points.

        ``{name, length_m, closed, xy, latlon, start:{x, y, heading_deg}, origin:{lat, lon},
        features:[{kind, label, s_start, s_end}]}``.
        """
        step = max(1, math.ceil(len(self.s) / JSON_MAX_POINTS))
        idx = np.arange(0, len(self.s), step)
        if not self.closed and idx[-1] != len(self.s) - 1:
            idx = np.append(idx[: JSON_MAX_POINTS - 1], len(self.s) - 1)
        xs, ys = self.x[idx], self.y[idx]
        lat, lon = geo.xy_to_latlon(xs, ys, origin)
        lat0, lon0 = geo.origin_lat_lon(origin)
        return {
            "name": self.name,
            "length_m": round(self.length, 2),
            "closed": self.closed,
            "xy": [[round(float(a), 2), round(float(b), 2)] for a, b in zip(xs, ys)],
            "latlon": [[round(float(a), 7), round(float(b), 7)] for a, b in zip(lat, lon)],
            "start": {
                "x": round(self.start_line.x, 2),
                "y": round(self.start_line.y, 2),
                "heading_deg": round(self.start_line.heading_deg, 2),
            },
            "origin": {"lat": lat0, "lon": lon0},
            "features": [
                {
                    "kind": f.kind,
                    "label": f.label,
                    "s_start": round(f.s_start, 1),
                    "s_end": round(f.s_end, 1),
                }
                for f in self.features
            ],
        }

    # ------------------------------------------------------------------ helpers
    def _closed_arrays(self) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        """``(x, y, s, theta_unwrapped)``; closed tracks get the start point appended at
        ``s = length`` (heading continued by +/-2π) so interpolation wraps seamlessly."""
        return _closed_arrays_cached(self)


@functools.lru_cache(maxsize=32)
def _closed_arrays_cached(track: Track) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    theta = np.unwrap(np.radians(90.0 - np.asarray(track.heading)))
    if not track.closed:
        return track.x, track.y, track.s, theta
    turn = theta[-1] - theta[0]
    total = 2.0 * math.pi * round(turn / (2.0 * math.pi))  # full turns made by one lap
    return (
        np.append(track.x, track.x[0]),
        np.append(track.y, track.y[0]),
        np.append(track.s, track.length),
        np.append(theta, theta[0] + total),
    )


def _compass_from_theta(theta: np.ndarray | float) -> np.ndarray | float:
    """Maths angle [rad] (from +x, anticlockwise) → compass heading [deg] (0 = N, clockwise)."""
    h = np.mod(90.0 - np.degrees(theta), 360.0)
    return np.where(h >= 360.0, 0.0, h)


# ====================================================================== curvature program
class _CurvatureProgram:
    """Piecewise-linear curvature profile κ(s) assembled from track elements.

    Elements append *knots* ``(s, κ)``; between knots κ varies linearly, which is exactly a
    clothoid. Turns are ``transition → constant radius → transition``; a turn of angle ψ
    (rad) with radius R and transition length Lt needs a constant-radius part
    ``L_arc = ψ·R − Lt`` because each linear ramp contributes half of its full-curvature
    angle (``Lt/(2R)``).
    """

    def __init__(self) -> None:
        self.s_knots: list[float] = [0.0]
        self.k_knots: list[float] = [0.0]
        self.features: list[TrackFeature] = []

    @property
    def s(self) -> float:
        return self.s_knots[-1]

    def _add(self, length: float, kappa_end: float) -> None:
        self.s_knots.append(float(self.s + length))
        self.k_knots.append(float(kappa_end))

    def straight(self, length: float, label: str | None = None) -> None:
        """Zero curvature for ``length`` metres."""
        if length < 0:
            raise ValueError(f"negative straight length {length:.2f} m")
        s0 = self.s
        self._add(length, 0.0)
        if label:
            self.features.append(TrackFeature("straight", label, s0, self.s))

    def turn(
        self,
        radius: float,
        angle_deg: float,
        transition: float,
        kind: str = "corner",
        label: str | None = None,
    ) -> None:
        """Clothoid-in, arc, clothoid-out. ``angle_deg`` > 0 turns left, < 0 turns right.

        ``kind`` labels the :class:`TrackFeature` recorded for this turn (empty = none).
        """
        if radius <= 0 or transition <= 0:
            raise ValueError("radius and transition must be positive")
        psi = math.radians(abs(angle_deg))
        arc = psi * radius - transition
        if arc < 0:
            raise ValueError(
                f"turn R={radius} m, {angle_deg}° too short for a {transition} m transition"
            )
        k = math.copysign(1.0 / radius, angle_deg)
        s0 = self.s
        self._add(transition, k)
        self._add(arc, k)
        self._add(transition, 0.0)
        if kind:
            self.features.append(TrackFeature(kind, label or kind, s0, self.s))

    def chicane(self, radius: float, angle_deg: float, transition: float, label: str) -> None:
        """Three linked turns ``angle, −2·angle, angle``: a lateral jog with no net turning."""
        s0 = self.s
        for a in (angle_deg, -2.0 * angle_deg, angle_deg):
            self.turn(radius, a, transition, kind="")
        self.features.append(TrackFeature("chicane", label, s0, self.s))

    def slalom(self, cones: int, spacing: float, amplitude: float, label: str = "Slalom") -> None:
        """Weave through ``cones`` cones ``spacing`` metres apart.

        The driven line is close to ``y = A·sin(π s / d)``, whose peak curvature is
        ``κ̂ = A (π/d)²``. Each cone spacing is one half-sine of curvature; the first and last
        half-waves have half amplitude so the heading oscillates symmetrically about the
        entry direction and the slalom exits on the line it entered (net turning zero).
        """
        if cones < 3 or cones % 2 == 0:
            raise ValueError("use an odd number (≥ 3) of cones so the slalom exits straight")
        k_peak = amplitude * (math.pi / spacing) ** 2
        # one half-wave of curvature per cone: +½, −1, +1, …, −1, +½ (sums to zero)
        weights = [0.5] + [(-1.0) ** i for i in range(1, cones - 1)] + [0.5]
        s0 = self.s
        samples = 16  # knots per half-wave: piecewise-linear sine, error < 1 %
        for w in weights:
            for j in range(1, samples + 1):
                self._add(spacing / samples, w * k_peak * math.sin(math.pi * j / samples))
        self.features.append(TrackFeature("slalom", label, s0, self.s))

    def kappa_at(self, s: np.ndarray) -> np.ndarray:
        return np.interp(s, np.asarray(self.s_knots), np.asarray(self.k_knots))

    def integrate(self, theta0: float = 0.0) -> tuple[np.ndarray, ...]:
        """Integrate κ(s) → (s, x, y, θ, κ) on a fine grid starting at the origin.

        θ is integrated with the trapezoidal rule, which is exact for piecewise-linear κ when
        the knots fall on the grid; x and y use the trapezoidal rule on cos θ and sin θ
        (error ≈ ds²·κ/12 per metre, i.e. sub-millimetre over a lap).
        """
        n = max(int(math.ceil(self.s / _INTEGRATION_DS_M)), 2)
        s = np.linspace(0.0, self.s, n + 1)
        s = np.union1d(s, np.asarray(self.s_knots))  # put every knot on the grid
        kappa = self.kappa_at(s)
        ds = np.diff(s)
        theta = theta0 + np.concatenate(([0.0], np.cumsum(0.5 * (kappa[1:] + kappa[:-1]) * ds)))
        c, sn = np.cos(theta), np.sin(theta)
        x = np.concatenate(([0.0], np.cumsum(0.5 * (c[1:] + c[:-1]) * ds)))
        y = np.concatenate(([0.0], np.cumsum(0.5 * (sn[1:] + sn[:-1]) * ds)))
        return s, x, y, theta, kappa


# ====================================================================== periodic spline
class _PeriodicCubicSpline:
    """Interpolating periodic cubic spline through 2-D points (chord-length parameter).

    For knots t_i with spacing h_i and values p_i, the second derivatives M_i solve the
    cyclic tridiagonal system::

        h_{i-1} M_{i-1} + 2 (h_{i-1} + h_i) M_i + h_i M_{i+1}
            = 6 [ (p_{i+1} − p_i)/h_i − (p_i − p_{i-1})/h_{i-1} ]

    (indices wrap round). With ≤ a few hundred control points a dense solve is instant.
    """

    def __init__(self, points: np.ndarray) -> None:
        n = len(points)
        closed = np.vstack([points, points[:1]])
        h = np.hypot(*np.diff(closed, axis=0).T)
        if np.any(h < 1e-9):
            raise ValueError("duplicate consecutive control points")
        a = np.zeros((n, n))
        rhs = np.zeros((n, 2))
        for i in range(n):
            h_prev, h_i = h[i - 1], h[i]
            a[i, i - 1] += h_prev
            a[i, i] += 2.0 * (h_prev + h_i)
            a[i, (i + 1) % n] += h_i
            rhs[i] = 6.0 * (
                (closed[i + 1] - points[i]) / h_i - (points[i] - points[i - 1]) / h_prev
            )
        self.m = np.linalg.solve(a, rhs)
        self.p = points
        self.h = h
        self.t = np.concatenate(([0.0], np.cumsum(h)))
        self.period = float(self.t[-1])

    def evaluate(self, t: np.ndarray) -> tuple[tuple[np.ndarray, np.ndarray], ...]:
        """Position, first and second derivative (each as ``(x, y)``) at parameters ``t``."""
        n = len(self.p)
        t = np.mod(t, self.period)
        i = np.clip(np.searchsorted(self.t, t, side="right") - 1, 0, n - 1)
        j = (i + 1) % n
        h = self.h[i][:, None]
        a = (self.t[i + 1] - t)[:, None]
        b = (t - self.t[i])[:, None]
        mi, mj, pi, pj = self.m[i], self.m[j], self.p[i], self.p[j]
        pos = (mi * a**3 + mj * b**3) / (6 * h) + (pi / h - mi * h / 6) * a + (pj / h - mj * h / 6) * b
        d1 = (-mi * a**2 + mj * b**2) / (2 * h) - (pi / h - mi * h / 6) + (pj / h - mj * h / 6)
        d2 = (mi * a + mj * b) / h
        return (pos[:, 0], pos[:, 1]), (d1[:, 0], d1[:, 1]), (d2[:, 0], d2[:, 1])


# ====================================================================== built-in tracks
def _endurance_program(main_a: float, west_c: float) -> _CurvatureProgram:
    """The ``fs_endurance`` layout as a curvature program (anticlockwise, +360° per lap).

    ``main_a`` (the main straight up to the start line, running east) and ``west_c`` (the
    straight down the west side, running south) are the two closure unknowns solved by
    :func:`_close_loop`; being perpendicular they fix the end point's x and y independently.
    The last corner's angle (``None`` below) makes the total turning exactly +360°.
    Element tuples: ``("straight", length, label)``, ``("turn", R, angle°, transition,
    kind, label)`` with angle > 0 = left, ``("chicane", R, first angle°, transition, label)``,
    ``("slalom", cones, spacing, amplitude, label)``.
    """
    layout: list[tuple] = [
        ("straight", 35.0, "Main straight"),
        ("turn", 12.0, 90.0, 6.0, "corner", "T1"),
        ("straight", 15.0, None),
        ("turn", 9.0, 90.0, 6.0, "corner", "T2"),
        ("straight", 25.0, None),
        ("turn", 6.0, -180.0, 4.0, "hairpin", "T3 hairpin"),
        ("straight", 20.0, None),
        ("turn", 10.0, 90.0, 6.0, "corner", "T4"),
        ("straight", 12.0, None),
        ("slalom", 7, 10.0, 1.0, "Slalom"),
        ("straight", 15.0, None),
        ("turn", 20.0, -45.0, 6.0, "sweeper", "T5 sweeper"),
        ("straight", 10.0, None),
        ("turn", 15.0, 135.0, 6.0, "corner", "T6"),
        ("straight", 50.0, "Top straight"),
        ("chicane", 12.0, -40.0, 4.0, "Chicane"),
        ("straight", 40.0, None),
        ("turn", 5.5, 180.0, 4.0, "hairpin", "T7 hairpin"),
        ("straight", 45.0, None),
        ("turn", 10.0, -90.0, 6.0, "corner", "T8"),
        ("straight", 20.0, None),
        ("turn", 9.0, -90.0, 6.0, "corner", "T9"),
        ("straight", 15.0, None),
        ("turn", 20.0, 90.0, 8.0, "sweeper", "T10 sweeper"),
        ("straight", 25.0, None),
        ("turn", 6.0, 180.0, 4.0, "hairpin", "T11 hairpin"),
        ("straight", 30.0, None),
        ("turn", 6.5, -180.0, 4.0, "hairpin", "T12 hairpin"),
        ("straight", 20.0, None),
        ("turn", 15.0, 45.0, 6.0, "corner", "T13 esses"),
        ("turn", 15.0, -45.0, 6.0, "corner", "T14 esses"),
        ("straight", west_c, "West straight"),
        ("turn", 14.0, None, 6.0, "corner", "T15"),
        ("straight", main_a, "Main straight"),
    ]
    fixed_turning = sum(e[2] for e in layout if e[0] == "turn" and e[2] is not None)
    closing_angle = 360.0 - fixed_turning
    prog = _CurvatureProgram()
    for element in layout:
        kind = element[0]
        if kind == "straight":
            prog.straight(element[1], element[2])
        elif kind == "turn":
            _, radius, angle, transition, feat, label = element
            prog.turn(radius, closing_angle if angle is None else angle, transition, feat, label)
        elif kind == "chicane":
            _, radius, angle, transition, label = element
            prog.chicane(radius, angle, transition, label)
        else:
            _, cones, spacing, amplitude, label = element
            prog.slalom(cones, spacing, amplitude, label)
    return prog


def _close_loop(
    build: Callable[[float, float], _CurvatureProgram], guess: tuple[float, float]
) -> tuple[_CurvatureProgram, tuple[float, ...]]:
    """Newton–Raphson on two straight lengths so that the loop ends where it started.

    Residual r(p) = (x_end, y_end); Jacobian by finite differences (2×2). The end position
    is linear in each straight length times the fixed direction of that straight, so Newton
    converges in one or two iterations.
    """
    p = np.array(guess, dtype=float)
    for _ in range(20):
        _, x, y, _, _ = build(*p).integrate()
        r = np.array([x[-1], y[-1]])
        if np.hypot(*r) < 1e-6:
            break
        jac = np.zeros((2, 2))
        for k in range(2):
            dp = p.copy()
            dp[k] += 1e-3
            _, xk, yk, _, _ = build(*dp).integrate()
            jac[:, k] = (np.array([xk[-1], yk[-1]]) - r) / 1e-3
        p = p - np.linalg.solve(jac, r)
    else:  # pragma: no cover - the layout is fixed and converges
        raise RuntimeError("track closure did not converge")
    if np.any(p < 0):
        raise ValueError(f"track layout cannot close with non-negative straights: {p}")
    return build(*p), tuple(p)


def _program_to_track(
    name: str,
    prog: _CurvatureProgram,
    closed: bool,
    start_heading_deg: float,
    finish_s: float | None = None,
) -> Track:
    theta0 = math.radians(90.0 - start_heading_deg)
    s, x, y, theta, kappa = prog.integrate(theta0)
    return Track.from_samples(
        name, closed, s, x, y, theta, kappa, finish_s=finish_s, features=prog.features
    )


def build_fs_endurance() -> Track:
    """Formula Student endurance / autocross circuit (≈ 1 km, anticlockwise).

    Main straight with the start line → T1 → T2 sweeper → 7-cone slalom (10 m spacing) →
    T3 hairpin (R 5.5 m) → back straight → left-right-left chicane → T4 sweeper (R 25 m) →
    T5 → T6 hairpin (R 5 m) → T7 sweeper (R 30 m) → main straight. Designed to the FS rules'
    endurance guidance: straights ≤ 80 m, hairpins ≥ 9 m outside diameter, slalom cones
    7.5–12 m apart, constant turns ≤ 50 m diameter.
    """
    prog, _ = _close_loop(_endurance_program, guess=(36.0, 60.0))
    return _program_to_track("fs_endurance", prog, closed=True, start_heading_deg=90.0)


#: Skid-pad driven radius [m]: 15.25 m inner diameter / 2 + half the 3 m lane width.
SKIDPAD_RADIUS_M = 9.125


def build_skidpad() -> Track:
    """Skid-pad figure of eight: a right-hand circle then a left-hand circle.

    The circles (driven radius 9.125 m: inner cone circle Ø 15.25 m plus half the 3 m lane)
    have centres 18.25 m apart and touch at the crossover, where the start/timing line sits
    with the car heading north. Curvature flips from −1/R to +1/R at the crossover.
    The timing gate is crossed once per *circle*, exactly like the real event, so a "lap"
    detected by the line is one circle (half of ``length``).
    """
    r = SKIDPAD_RADIUS_M
    circle = 2.0 * math.pi * r
    prog = _CurvatureProgram()
    prog.s_knots = [0.0, circle, circle + 1e-9, 2.0 * circle]
    prog.k_knots = [-1.0 / r, -1.0 / r, 1.0 / r, 1.0 / r]
    prog.features = [
        TrackFeature("corner", "Right circle", 0.0, circle),
        TrackFeature("corner", "Left circle", circle, 2.0 * circle),
    ]
    return _program_to_track("skidpad", prog, closed=True, start_heading_deg=0.0)


#: Acceleration event: timed length and braking run-off [m].
ACCEL_LENGTH_M = 75.0
ACCEL_RUNOFF_M = 100.0


def build_acceleration() -> Track:
    """Acceleration event: a 75 m timed straight (``finish_s``) plus a 100 m braking run-off.

    Open track heading east; the car starts from rest at ``s = 0`` and must stop by the end.
    """
    prog = _CurvatureProgram()
    prog.straight(ACCEL_LENGTH_M, "Timed 75 m")
    prog.straight(ACCEL_RUNOFF_M, "Run-off")
    return _program_to_track(
        "acceleration", prog, closed=False, start_heading_deg=90.0, finish_s=ACCEL_LENGTH_M
    )


#: Registry of built-in tracks: name → builder.
TRACKS: Mapping[str, Callable[[], Track]] = {
    "fs_endurance": build_fs_endurance,
    "skidpad": build_skidpad,
    "acceleration": build_acceleration,
}


@functools.lru_cache(maxsize=None)
def get_track(name: str = "fs_endurance") -> Track:
    """Return the built-in track ``name`` (built once, then cached; arrays are read-only)."""
    try:
        builder = TRACKS[name]
    except KeyError:
        raise KeyError(f"unknown track {name!r}; available: {', '.join(TRACKS)}") from None
    return builder()
