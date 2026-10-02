"""Geometry tests for the built-in tracks (SPEC §5.1) and the Track API."""

import json
import math

import numpy as np
import pytest

from aerovolt.core import geo
from aerovolt.sim import tracks
from aerovolt.sim.tracks import Track, get_track

ORIGIN = {"lat": 52.0786, "lon": -1.0169}


@pytest.fixture(scope="module")
def endurance() -> Track:
    return get_track("fs_endurance")


def _segments(track: Track) -> tuple[np.ndarray, np.ndarray]:
    """Polyline segments (start points, end points), closing the loop if closed."""
    p = np.column_stack([track.x, track.y])
    q = np.roll(p, -1, axis=0) if track.closed else p[1:]
    return (p if track.closed else p[:-1]), q


def _runs(mask: np.ndarray, closed: bool) -> list[int]:
    """Lengths of consecutive True runs (wrapping round for a closed track)."""
    if closed and mask.all():
        return [len(mask)]
    if closed and mask[0] and mask[-1]:
        k = int(np.argmin(mask))  # rotate so the array starts on a False
        mask = np.roll(mask, -k)
    runs, cur = [], 0
    for m in mask:
        cur = cur + 1 if m else 0
        if cur == 1:
            runs.append(0)
        if m:
            runs[-1] = cur
    return runs


# ------------------------------------------------------------------ fs_endurance constraints
def test_endurance_is_closed_loop_of_fs_length(endurance):
    assert endurance.closed
    assert 900.0 <= endurance.length <= 1100.0
    # uniform sampling 0.5–1 m and the last point connects back to the first
    assert 0.49 <= endurance.ds <= 1.0
    assert np.allclose(np.diff(endurance.s), endurance.ds)
    gap = math.hypot(endurance.x[0] - endurance.x[-1], endurance.y[0] - endurance.y[-1])
    assert gap == pytest.approx(endurance.ds, abs=0.01)


def test_endurance_turns_once_anticlockwise_with_continuous_heading(endurance):
    theta = np.unwrap(np.radians(90.0 - endurance.heading))
    closing = theta[0] + 2 * math.pi - theta[-1]  # heading change over the closing segment
    assert theta[-1] - theta[0] + closing == pytest.approx(2 * math.pi)
    assert abs(closing) < 0.01
    # heading agrees with the direction of the sampled centreline
    p, q = _segments(endurance)
    seg_heading = geo.heading_deg(q[:, 0] - p[:, 0], q[:, 1] - p[:, 1])
    diff = (seg_heading - endurance.heading + 180.0) % 360.0 - 180.0
    assert np.max(np.abs(diff)) < 3.0  # within half a step of a 5.5 m hairpin


def test_endurance_minimum_radius_from_curvature(endurance):
    r_min = 1.0 / np.max(np.abs(endurance.kappa))
    assert r_min >= 4.5  # FS: hairpins ≥ 9 m outside diameter → centreline radius ≥ 4.5 m


def test_endurance_curvature_matches_geometry(endurance):
    """κ stored with the track equals dθ/ds of the sampled positions (no hidden kinks)."""
    p, q = _segments(endurance)
    theta = np.unwrap(np.arctan2(q[:, 1] - p[:, 1], q[:, 0] - p[:, 0]))
    k_geo = np.diff(theta) / endurance.ds  # turning between segment i and i+1 ≈ κ at point i+1
    assert np.max(np.abs(k_geo - endurance.kappa[1:])) < 0.005


def test_endurance_curvature_is_smooth(endurance):
    """Clothoid transitions: curvature never jumps (|Δκ| per sample well below 1/R_min)."""
    dk = np.abs(np.diff(np.append(endurance.kappa, endurance.kappa[0])))
    assert dk.max() < 0.03


def test_endurance_longest_straight_at_most_80m(endurance):
    """Straight = |κ| < 1/200 m⁻¹ (radius > 200 m). Tolerance: the ends of clothoid
    transitions below that curvature count as straight, which adds ≈ 1 m at each end, so
    the designed straights are kept ≤ 75 m and the measured value must be ≤ 80 m."""
    runs = _runs(np.abs(endurance.kappa) < 1.0 / 200.0, closed=True)
    longest = max(runs) * endurance.ds
    assert 40.0 <= longest <= 80.0


def test_endurance_does_not_self_intersect(endurance):
    p, q = _segments(endurance)
    n = len(p)
    d = q - p
    # pairwise segment intersection via orientation tests (vectorised, chunked)
    hits = 0
    for i0 in range(0, n, 400):
        a, b = p[i0 : i0 + 400, None, :], d[i0 : i0 + 400, None, :]
        c, e = p[None, :, :], d[None, :, :]
        denom = b[..., 0] * e[..., 1] - b[..., 1] * e[..., 0]
        ac = c - a
        with np.errstate(divide="ignore", invalid="ignore"):
            t = (ac[..., 0] * e[..., 1] - ac[..., 1] * e[..., 0]) / denom
            u = (ac[..., 0] * b[..., 1] - ac[..., 1] * b[..., 0]) / denom
        inter = (np.abs(denom) > 1e-12) & (t > 1e-9) & (t < 1 - 1e-9) & (u > 1e-9) & (u < 1 - 1e-9)
        idx_i = np.arange(i0, min(i0 + 400, n))[:, None]
        idx_j = np.arange(n)[None, :]
        gap = np.abs(idx_i - idx_j)
        gap = np.minimum(gap, n - gap)
        hits += int(np.sum(inter & (gap > 1)))
    assert hits == 0


def test_endurance_sections_are_well_separated(endurance):
    """Parts of the lap that are far apart along the track are ≥ 8 m apart on the ground
    (3 m track width + run-off), i.e. the track does not even come close to crossing."""
    xy = np.column_stack([endurance.x, endurance.y])
    d = np.hypot(*(xy[:, None, :] - xy[None, :, :]).transpose(2, 0, 1))
    ds_along = np.abs(endurance.s[:, None] - endurance.s[None, :])
    ds_along = np.minimum(ds_along, endurance.length - ds_along)
    assert d[ds_along > 40.0].min() >= 8.0


def test_endurance_has_fs_features(endurance):
    kinds = {f.kind for f in endurance.features}
    assert {"slalom", "chicane", "hairpin", "sweeper"} <= kinds
    hairpins = [f for f in endurance.features if f.kind == "hairpin"]
    assert len(hairpins) >= 2
    for f in endurance.features:
        assert 0.0 <= f.s_start < f.s_end <= endurance.length + 1e-6


def test_endurance_slalom_cone_spacing(endurance):
    """Slalom apexes (curvature extrema) are 7.5–12 m apart and alternate direction."""
    sl = next(f for f in endurance.features if f.kind == "slalom")
    m = (endurance.s >= sl.s_start) & (endurance.s <= sl.s_end)
    k, s = endurance.kappa[m], endurance.s[m]
    peaks = [i for i in range(1, len(k) - 1) if abs(k[i]) >= abs(k[i - 1]) and abs(k[i]) > abs(k[i + 1])]
    spacing = np.diff(s[peaks])
    assert len(peaks) >= 5
    assert np.all((spacing >= 7.5) & (spacing <= 12.0))
    assert np.all(np.sign(k[peaks][1:]) != np.sign(k[peaks][:-1]))
    assert 1.0 / np.max(np.abs(k)) > 6.0  # a slalom, not a series of hairpins


def test_endurance_sweepers_are_long_constant_radius(endurance):
    for f in (f for f in endurance.features if f.kind == "sweeper"):
        m = (endurance.s >= f.s_start) & (endurance.s <= f.s_end)
        radius = 1.0 / np.max(np.abs(endurance.kappa[m]))
        assert 15.0 <= radius <= 25.0 + 1e-6  # FS: constant-radius turns ≤ 50 m diameter
        assert f.s_end - f.s_start > 15.0


# ------------------------------------------------------------------ skidpad & acceleration
def test_skidpad_figure_of_eight_geometry():
    sk = get_track("skidpad")
    r = tracks.SKIDPAD_RADIUS_M
    assert r == pytest.approx(15.25 / 2 + 1.5)
    assert sk.closed
    assert sk.length == pytest.approx(2 * 2 * math.pi * r, rel=1e-6)
    assert np.allclose(np.abs(sk.kappa), 1.0 / r)
    right = sk.s < sk.length / 2
    assert np.all(sk.kappa[right][1:] < 0) and np.all(sk.kappa[~right] > 0)
    d_right = np.hypot(sk.x[right] - r, sk.y[right])
    d_left = np.hypot(sk.x[~right] + r, sk.y[~right])
    assert np.allclose(d_right, r, atol=0.01) and np.allclose(d_left, r, atol=0.01)
    assert sk.start_line.x == pytest.approx(0.0) and sk.start_line.y == pytest.approx(0.0)
    assert sk.start_line.heading_deg == pytest.approx(0.0)


def test_acceleration_is_open_75m_plus_runoff():
    acc = get_track("acceleration")
    assert not acc.closed
    assert acc.finish_s == pytest.approx(75.0)
    assert acc.length == pytest.approx(tracks.ACCEL_LENGTH_M + tracks.ACCEL_RUNOFF_M)
    assert acc.s[0] == 0.0 and acc.s[-1] == pytest.approx(acc.length)
    assert np.allclose(acc.kappa, 0.0)
    assert np.allclose(acc.y, 0.0, atol=1e-9)
    assert acc.x[-1] == pytest.approx(acc.length, abs=1e-6)


# ------------------------------------------------------------------ API
def test_registry_and_cache():
    assert set(tracks.TRACKS) == {"fs_endurance", "skidpad", "acceleration"}
    assert get_track("fs_endurance") is get_track("fs_endurance")
    with pytest.raises(KeyError, match="available"):
        get_track("monaco")


def test_arrays_are_read_only(endurance):
    with pytest.raises(ValueError):
        endurance.x[0] = 1.0


def test_position_at_matches_samples_and_wraps(endurance):
    i = 321
    x, y, h = endurance.position_at(endurance.s[i])
    assert (x, y, h) == pytest.approx((endurance.x[i], endurance.y[i], endurance.heading[i]))
    x2, y2, _ = endurance.position_at(endurance.s[i] + 3 * endurance.length)
    assert (x2, y2) == pytest.approx((x, y))
    xs, ys, hs = endurance.position_at(np.array([0.0, endurance.length]))
    assert xs[0] == pytest.approx(xs[1]) and ys[0] == pytest.approx(ys[1])
    # interpolation half-way between samples lies between them
    xm, ym, _ = endurance.position_at(endurance.s[i] + endurance.ds / 2)
    assert xm == pytest.approx(0.5 * (endurance.x[i] + endurance.x[i + 1]))


def test_position_heading_interpolates_across_north():
    sk = get_track("skidpad")  # starts heading 0° (north) at the crossover
    _, _, h_before = sk.position_at(-0.1)
    _, _, h_after = sk.position_at(0.1)
    assert (h_before > 359.0 or h_before < 1.0) and (h_after > 359.0 or h_after < 1.0)


def test_position_at_clamps_open_track():
    acc = get_track("acceleration")
    assert acc.position_at(-5.0)[0] == pytest.approx(0.0)
    assert acc.position_at(1e4)[0] == pytest.approx(acc.length)


def test_nearest_s_projects_offset_points(endurance):
    for s_true in (5.0, 222.2, 500.7, 900.3):
        x, y, h = endurance.position_at(s_true)
        nx, ny = -math.cos(math.radians(h)), math.sin(math.radians(h))  # unit normal
        s_found = endurance.nearest_s(x + 1.2 * nx, y + 1.2 * ny)
        assert s_found == pytest.approx(s_true, abs=0.1)


def test_nearest_s_with_hint_resolves_skidpad_crossover():
    sk = get_track("skidpad")
    half = sk.length / 2
    # at the crossover both circles pass through (0, 0): the hint decides which one
    assert sk.nearest_s(0.0, 0.0, s_hint=half - 1.0, window_m=5.0) == pytest.approx(half, abs=0.3)
    s0 = sk.nearest_s(0.0, 0.0, s_hint=1.0, window_m=5.0)
    assert min(s0, sk.length - s0) < 0.3


def test_start_line_crossing_forward_only(endurance):
    line = endurance.start_line
    before = endurance.position_at(-0.4)[:2]
    after = endurance.position_at(0.4)[:2]
    assert endurance.crossed_start_line(before, after)
    assert not endurance.crossed_start_line(after, before)  # reversing over the line
    assert not endurance.crossed_start_line(before, before)
    far = (line.x + 0.0, line.y + 30.0)  # 30 m to the side of the gate
    assert not endurance.crossed_start_line((far[0] - 1.0, far[1]), (far[0] + 1.0, far[1]))


def _count_crossings(track: Track) -> int:
    s = np.arange(0.0, track.length, 0.7) + 0.3
    x, y, _ = track.position_at(s)
    pts = list(zip(x, y))
    pts.append(pts[0])
    return sum(track.crossed_start_line(a, b) for a, b in zip(pts[:-1], pts[1:]))


def test_one_lap_crosses_the_line_once(endurance):
    assert _count_crossings(endurance) == 1


def test_skidpad_line_crossed_once_per_circle():
    assert _count_crossings(get_track("skidpad")) == 2


def test_to_json_contract(endurance):
    js = endurance.to_json(ORIGIN)
    assert set(js) >= {"name", "length_m", "closed", "xy", "latlon", "start", "origin"}
    assert js["name"] == "fs_endurance" and js["closed"] is True
    assert len(js["xy"]) <= tracks.JSON_MAX_POINTS and len(js["xy"]) == len(js["latlon"])
    assert js["origin"] == ORIGIN
    assert set(js["start"]) == {"x", "y", "heading_deg"}
    lat, lon = js["latlon"][10]
    x, y = geo.latlon_to_xy(lat, lon, ORIGIN)
    assert (x, y) == pytest.approx(tuple(js["xy"][10]), abs=0.02)
    json.dumps(js, allow_nan=False)  # strictly valid JSON


def test_to_json_open_track_keeps_end_point():
    acc = get_track("acceleration")
    js = acc.to_json(ORIGIN)
    assert js["xy"][-1][0] == pytest.approx(acc.length, abs=0.01)
    assert js["closed"] is False


def test_from_control_points_periodic_spline_circle():
    r = 20.0
    ang = np.linspace(0, 2 * np.pi, 16, endpoint=False)
    pts = np.column_stack([r * np.cos(ang), r * np.sin(ang)])
    tr = Track.from_control_points("circle", pts)
    assert tr.closed
    assert tr.length == pytest.approx(2 * np.pi * r, rel=2e-3)
    assert np.allclose(tr.kappa, 1.0 / r, rtol=0.02)  # anticlockwise → positive
    assert np.allclose(np.hypot(tr.x, tr.y), r, atol=0.05)


def test_from_control_points_rejects_bad_input():
    with pytest.raises(ValueError):
        Track.from_control_points("bad", [[0, 0], [1, 0], [1, 1]])
