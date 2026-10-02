"""Tests for aerovolt.analysis.laps: GPS lap timing, debounce, gates, summaries."""

from __future__ import annotations

import math

import numpy as np
import pytest

from aerovolt.analysis.laps import LapAccumulator, LapDetector, default_debounce_s
from aerovolt.core import geo
from aerovolt.sim import lapsim
from aerovolt.sim.tracks import get_track
from test_analysis_synthetic import config

ORIGIN = config().vehicle["gps_origin"]


def _fixes(track, laps: float, s0: float = 0.0, hz: float = 10.0, noise_m: float = 0.0, seed: int = 0):
    """GPS fixes (t, lat, lon) of a car following the lap-sim speed profile."""
    res = lapsim.solve(track, lapsim.VehicleParams.from_dict(config().vehicle))
    rng = np.random.default_rng(seed)
    t, s, out = 0.0, s0, []
    while s < s0 + laps * track.length:
        x, y, _ = track.position_at(s)
        x += rng.normal(0, noise_m) if noise_m else 0.0
        y += rng.normal(0, noise_m) if noise_m else 0.0
        lat, lon = geo.xy_to_latlon(x, y, ORIGIN)
        out.append((t, float(lat), float(lon)))
        v = float(np.interp(s % track.length, res.s, res.v, period=track.length))
        s += v / hz
        t += 1.0 / hz
    return out, res


def test_lap_times_from_gps_match_lapsim():
    track = get_track("fs_endurance")
    fixes, res = _fixes(track, 3.2, s0=-30.0)  # rolling start 30 m before the line
    det = LapDetector(ORIGIN, track=track)
    events = [e for e in (det.update(*f) for f in fixes) if e is not None]
    assert det.lap == 4  # crossed the line 4 times: out-lap, then laps 1..3
    assert [e.lap for e in events] == [1, 2, 3]
    for e in events:
        assert e.lap_time == pytest.approx(res.lap_time, abs=0.15)


def test_standing_start_times_lap_one_from_the_grid():
    track = get_track("fs_endurance")
    fixes, res = _fixes(track, 1.1, s0=0.0)
    det = LapDetector(ORIGIN, track=track)
    events = [e for e in (det.update(*f) for f in fixes) if e is not None]
    assert len(events) == 1 and events[0].lap == 1
    assert events[0].t_start == 0.0
    assert events[0].lap_time == pytest.approx(res.lap_time, abs=0.15)


def test_grid_slot_just_behind_the_line_starts_timing_at_the_line():
    track = get_track("fs_endurance")
    fixes, res = _fixes(track, 1.1, s0=-6.0)
    det = LapDetector(ORIGIN, track=track)
    det.update(*fixes[0])
    assert det.lap == 1  # standing start detected
    events = [e for e in (det.update(*f) for f in fixes[1:]) if e is not None]
    assert len(events) == 1 and events[0].t_start > 0.0
    assert events[0].lap_time == pytest.approx(res.lap_time, abs=0.15)


def test_debounce_ignores_gps_jitter_on_the_line():
    track = get_track("fs_endurance")
    det = LapDetector(ORIGIN, track=track)
    xs = [-20.0, -2.0, 1.0, -1.0, 1.5, -0.5, 2.0, 30.0]  # wobbling across the line (east-bound)
    t = 0.0
    crossings = 0
    for x in xs:
        lat, lon = geo.xy_to_latlon(x, 0.0, ORIGIN)
        lap_before = det.lap
        det.update(t, float(lat), float(lon))
        crossings += det.lap - lap_before
        t += 0.5
    assert crossings == 1


def test_sample_and_hold_fixes_and_nan_are_ignored():
    det = LapDetector(ORIGIN, track=get_track("fs_endurance"))
    assert det.update(1.0, float("nan"), 0.0) is None
    lat, lon = geo.xy_to_latlon(100.0, 50.0, ORIGIN)
    det.update(1.0, float(lat), float(lon))
    pos = det.position
    assert det.update(1.0, float(lat), float(lon)) is None and det.position == pos


def test_configured_gate_learns_direction_from_first_crossing():
    # gate posts north/south of a road running west -> east through x = 0
    p1 = geo.xy_to_latlon(0.0, 5.0, ORIGIN)
    p2 = geo.xy_to_latlon(0.0, -5.0, ORIGIN)
    det = LapDetector(ORIGIN, gate=[[float(p1[0]), float(p1[1])], [float(p2[0]), float(p2[1])]], debounce_s=5.0)
    assert det.has_gate
    t, events = 0.0, []
    for lap in range(3):
        for x in np.arange(-200.0, 200.0, 5.0):  # each pass west -> east, 10 s per pass
            lat, lon = geo.xy_to_latlon(x, 1.0, ORIGIN)
            ev = det.update(t, float(lat), float(lon))
            if ev:
                events.append(ev)
            t += 0.125
        # drive back east -> west far from the gate (y = 200 m): no crossing
        for x in np.arange(200.0, -200.0, -20.0):
            lat, lon = geo.xy_to_latlon(x, 200.0, ORIGIN)
            det.update(t, float(lat), float(lon))
            t += 0.125
    assert [e.lap for e in events] == [1, 2]  # first crossing = start of lap 1
    assert events[0].lap_time == pytest.approx(events[1].lap_time, abs=0.01)
    # a pass in the opposite direction through the gate does not count
    lap_before = det.lap
    for x in np.arange(200.0, -200.0, -5.0):
        lat, lon = geo.xy_to_latlon(x, 0.0, ORIGIN)
        det.update(t, float(lat), float(lon))
        t += 0.125
    assert det.lap == lap_before


def test_gate_validation_and_no_gate():
    with pytest.raises(ValueError):
        LapDetector(ORIGIN, gate=[[52.0, -1.0], [52.0, -1.0]])
    det = LapDetector.from_context(config().vehicle, None, None)
    assert not det.has_gate
    assert det.update(0.0, 52.0786, -1.0169) is None and det.lap == 0
    assert math.isnan(det.lap_distance())


def test_debounce_shrinks_for_the_skidpad():
    assert default_debounce_s(get_track("fs_endurance")) == 5.0
    assert default_debounce_s(get_track("skidpad")) < 4.0
    assert default_debounce_s(None) == 5.0


def test_lap_accumulator_summary_uses_valid_samples_only():
    acc = LapAccumulator(t_start=10.0, energy_net_kwh=1.0, regen_kwh=0.2)
    for k in range(100):
        aero_valid = k % 2 == 0
        acc.add(0.5, 20.0, 3.5 if aero_valid else 99.0, float("nan"), 45.0, aero_valid,
                cell_t_max=30.0 + k * 0.01, cell_v_min=3.8 - k * 0.001, mot_temp=float("nan") if k else 80.0)
    s = acc.summary(lap=3, lap_time=50.0, energy_net_kwh=1.33, regen_kwh=0.28)
    assert s.lap == 3 and s.distance == pytest.approx(1000.0)
    assert s.v_avg == pytest.approx(20.0) and s.v_max == 20.0
    assert s.cla_avg == pytest.approx(3.5) and math.isnan(s.cda_avg) and s.balance_avg == 45.0
    assert s.energy_kwh == pytest.approx(0.33) and s.regen_kwh == pytest.approx(0.08)
    assert s.cell_t_max == pytest.approx(30.99) and s.cell_v_min == pytest.approx(3.701)
    assert s.mot_temp_max == 80.0
    js = s.to_json()
    assert js["cda_avg"] is None and js["lap"] == 3


def test_lap_distance_along_track():
    track = get_track("fs_endurance")
    det = LapDetector(ORIGIN, track=track)
    x, y, _ = track.position_at(300.0)
    lat, lon = geo.xy_to_latlon(x, y, ORIGIN)
    det.update(0.0, float(lat), float(lon))
    assert det.lap_distance() == pytest.approx(300.0, abs=0.5)
    assert det.lap_distance(s_hint=290.0) == pytest.approx(300.0, abs=0.5)
