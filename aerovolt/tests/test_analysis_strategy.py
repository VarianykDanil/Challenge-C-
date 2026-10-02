"""Tests for aerovolt.analysis.strategy (endurance energy strategy)."""

from __future__ import annotations

import math

import pytest

from aerovolt.analysis.strategy import EnduranceStrategy
from aerovolt.core.model import LapSummary
from aerovolt.sim.tracks import get_track
from test_analysis_synthetic import config

NAN = float("nan")


def _lap(n: int, energy: float, lap_time: float = 59.0, distance: float = 950.0) -> LapSummary:
    return LapSummary(n, lap_time, distance, distance / lap_time, 32.0, energy, 0.08, 3.6, 1.35, 45.5, 30.0, 3.6, 85.0)


@pytest.fixture(scope="module")
def strategy() -> EnduranceStrategy:
    return EnduranceStrategy(config().vehicle, get_track("fs_endurance"))


def test_laps_needed_and_energy_bookkeeping(strategy):
    assert strategy.laps_total() == 24  # ceil(22000 / 950.5)
    assert strategy.limits_kw == [40.0, 45.0, 50.0, 55.0, 60.0, 65.0, 70.0, 75.0, 80.0]
    p = strategy.params
    assert strategy.energy_remaining_kwh(100.0) == pytest.approx(p.usable_energy_kwh)
    assert strategy.energy_remaining_kwh(5.0) == 0.0
    assert strategy.energy_remaining_kwh(2.0) == 0.0
    assert math.isnan(strategy.energy_remaining_kwh(NAN))
    assert strategy.reserve_kwh == pytest.approx(0.05 * p.usable_energy_kwh)


def test_prediction_curve_is_monotonic(strategy):
    curve = strategy.predicted_curve(1.2)
    assert [c["kw"] for c in curve] == strategy.limits_kw
    energies = [c["energy_kwh"] for c in curve]
    times = [c["lap_time"] for c in curve]
    assert energies == sorted(energies)  # more power, more energy per lap ...
    assert times == sorted(times, reverse=True)  # ... and a faster lap
    assert strategy.predicted_curve(1.2) is curve  # cached


def test_full_pack_recommends_a_reduced_limit_and_flags_80kw(strategy):
    """SPEC 5.4: 80 kW for the whole endurance needs ~103 % of usable energy."""
    nominal = {c["kw"]: c for c in strategy.predicted_curve(1.2)}
    e80 = nominal[80.0]["energy_kwh"]
    res = strategy.evaluate([_lap(1, e80, nominal[80.0]["lap_time"])], soc_pct=99.0, current_kw=80.0)
    assert res.scale == pytest.approx(1.0, abs=1e-9)
    assert res.laps_needed == 24 and res.laps_done == 1 and res.laps_left == 23
    assert res.energy_short is True
    assert 50.0 <= res.recommended_kw <= 70.0
    e_rec = next(c["energy_kwh"] for c in res.curve if c["kw"] == res.recommended_kw)
    assert e_rec * 23 <= res.energy_available_kwh
    assert res.predicted_finish_soc > strategy.params.soc_window_min * 100
    assert res.laps_possible == pytest.approx(res.energy_available_kwh / e80)


def test_measured_consumption_scales_the_curve(strategy):
    nominal = {c["kw"]: c for c in strategy.predicted_curve(1.2)}
    e60 = nominal[60.0]["energy_kwh"]
    laps = [_lap(i + 1, e60 * 1.10) for i in range(4)]  # car uses 10 % more than modelled
    res = strategy.evaluate(laps, soc_pct=85.0, current_kw=60.0)
    assert res.scale == pytest.approx(1.10)
    assert res.energy_per_lap_kwh == pytest.approx(e60 * 1.10)
    assert all(c["energy_kwh"] == pytest.approx(nominal[c["kw"]]["energy_kwh"] * 1.10) for c in res.curve)
    calm = strategy.evaluate([_lap(i + 1, e60 * 0.9) for i in range(4)], soc_pct=85.0, current_kw=60.0)
    assert calm.recommended_kw >= res.recommended_kw


def test_plenty_of_energy_allows_full_power(strategy):
    nominal = {c["kw"]: c for c in strategy.predicted_curve(1.2)}
    laps = [_lap(i + 1, nominal[80.0]["energy_kwh"]) for i in range(20)]
    res = strategy.evaluate(laps, soc_pct=60.0, current_kw=80.0)
    assert res.laps_left == 4 and res.recommended_kw == 80.0 and not res.energy_short


def test_hopeless_case_recommends_the_lowest_limit(strategy):
    nominal = {c["kw"]: c for c in strategy.predicted_curve(1.2)}
    res = strategy.evaluate([_lap(1, nominal[80.0]["energy_kwh"])], soc_pct=30.0, current_kw=80.0)
    assert res.energy_short and res.recommended_kw == 40.0
    assert res.predicted_finish_soc < 5.0


def test_without_track_uses_measured_lap_length_and_consumption():
    strat = EnduranceStrategy(config().vehicle, track=None)
    laps = [_lap(i + 1, 0.30, distance=1100.0) for i in range(2)]
    res = strat.evaluate(laps, soc_pct=90.0)
    assert res.laps_needed == 20  # ceil(22000 / 1100)
    assert res.curve == [] and math.isnan(res.scale)
    assert res.current_kw == 80.0 and res.recommended_kw == 80.0  # fits: 18 x 0.30 kWh
    assert not res.energy_short


def test_missing_soc_and_no_laps_are_handled(strategy):
    res = strategy.evaluate([], soc_pct=NAN)
    assert math.isnan(res.energy_remaining_kwh) and math.isnan(res.recommended_kw)
    assert not res.energy_short
    js = res.to_json()
    assert js["recommended_kw"] is None and js["curve"] == []


def test_to_json_has_spec_fields(strategy):
    nominal = {c["kw"]: c for c in strategy.predicted_curve(1.2)}
    js = strategy.evaluate([_lap(1, nominal[80.0]["energy_kwh"])], soc_pct=97.0, current_kw=80.0).to_json()
    for key in ("laps_done", "laps_needed", "energy_remaining_kwh", "energy_per_lap_kwh", "recommended_kw",
                "predicted_finish_soc", "curve"):
        assert key in js
    assert set(js["curve"][0]) == {"kw", "lap_time", "energy_kwh"}
    assert isinstance(js["energy_short"], bool)
