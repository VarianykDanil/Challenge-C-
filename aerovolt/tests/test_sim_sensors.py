"""Virtual sensors (sim/sensors.py): lag, sampling rates, noise, quantisation, clipping."""

import math

import numpy as np
import pytest

from aerovolt.core.model import ChannelDef
from aerovolt.sim.sensors import OrnsteinUhlenbeck, VirtualSensorBank

DT = 0.01


def channel(cid: str, rate: float = 100, lo: float = -1e9, hi: float = 1e9, noise: float = 0.0,
            res: float = 0.0, lag: float = 0.0) -> ChannelDef:
    return ChannelDef(id=cid, name=cid, unit="-", system="vehicle", group="g", rate_hz=rate,
                      min=lo, max=hi, noise=noise, resolution=res, lag_s=lag)


def test_first_order_lag_is_exact_for_a_step():
    """y(t) = 1 − exp(−t/τ) for a unit step, sampled exactly at every step."""
    bank = VirtualSensorBank([channel("p", lag=0.05)], DT, np.random.default_rng(0))
    bank.reset(np.zeros(1))
    for k in range(1, 31):
        bank.update(np.ones(1))
        assert bank.sample(k)["p"] == pytest.approx(1.0 - math.exp(-k * DT / 0.05), abs=1e-12)


def test_channel_without_lag_follows_input_immediately():
    bank = VirtualSensorBank([channel("x")], DT, np.random.default_rng(0))
    bank.reset(np.zeros(1))
    bank.update(np.array([3.25]))
    assert bank.sample(1)["x"] == 3.25


def test_channels_are_due_at_their_catalogue_rate():
    chans = [channel("fast", 100), channel("half", 50), channel("ten", 10), channel("one", 1)]
    bank = VirtualSensorBank(chans, DT, np.random.default_rng(0))
    bank.reset(np.zeros(4))
    counts = {c.id: 0 for c in chans}
    for k in range(1, 201):  # two seconds
        for cid in bank.sample(k):
            counts[cid] += 1
    assert counts == {"fast": 200, "half": 100, "ten": 20, "one": 2}
    assert set(bank.sample(0)) == {"fast", "half", "ten", "one"}  # step 0: everything is due


def test_rate_must_divide_the_physics_rate():
    with pytest.raises(ValueError, match="divisor"):
        VirtualSensorBank([channel("odd", rate=30)], DT, np.random.default_rng(0))


def test_quantisation_and_range_clipping():
    chans = [channel("q", res=0.5), channel("c", lo=0.0, hi=10.0, res=0.1)]
    bank = VirtualSensorBank(chans, DT, np.random.default_rng(0))
    bank.reset(np.array([1.26, 12.0]))
    out = bank.sample(0)
    assert out["q"] == 1.5
    assert out["c"] == 10.0
    bank.reset(np.array([-0.24, -3.0]))
    out = bank.sample(0)
    assert out["q"] == 0.0
    assert out["c"] == 0.0


def test_noise_has_the_catalogue_sigma_and_is_seeded():
    def run(seed):
        bank = VirtualSensorBank([channel("n", noise=2.0)], DT, np.random.default_rng(seed))
        bank.reset(np.array([5.0]))
        return np.array([bank.sample(k)["n"] for k in range(4000)])

    a, b, c = run(1), run(1), run(2)
    assert np.array_equal(a, b)            # same seed → identical data
    assert not np.array_equal(a, c)
    assert a.mean() == pytest.approx(5.0, abs=0.1)
    assert a.std() == pytest.approx(2.0, rel=0.05)


def test_compass_heading_wraps_instead_of_clipping():
    bank = VirtualSensorBank([channel("gps_heading", lo=0, hi=360, res=0.01)], DT, np.random.default_rng(0))
    bank.reset(np.array([361.5]))
    assert bank.sample(0)["gps_heading"] == pytest.approx(1.5)
    bank.reset(np.array([-0.5]))
    assert bank.sample(0)["gps_heading"] == pytest.approx(359.5)


def test_ornstein_uhlenbeck_statistics():
    """Stationary σ and correlation time match the parameters (exact discretisation)."""
    ou = OrnsteinUhlenbeck(sigma=1.5, tau_s=0.2, dt=DT, rng=np.random.default_rng(3))
    x = np.array([ou.step() for _ in range(200_000)])[1000:]
    assert x.std() == pytest.approx(1.5, rel=0.05)
    lag = int(0.2 / DT)  # autocorrelation at one τ ≈ e^-1
    rho = np.corrcoef(x[:-lag], x[lag:])[0, 1]
    assert rho == pytest.approx(math.exp(-1.0), abs=0.05)
