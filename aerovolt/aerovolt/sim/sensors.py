"""Virtual sensors: turn the simulator's *true* values into realistic *measurements*.

A real sensor never reports the physical quantity itself. Between the two sit:

1. **Dynamics** — a first-order lag with time constant τ = ``lag_s`` (pneumatic tubing of a
   pressure tap, the thermal mass of a thermistor glued to a cell)::

       y[k+1] = y[k] + α·(x[k+1] − y[k]),      α = 1 − exp(−Δt / τ)

   This is the exact discretisation of ``τ·dy/dt = x − y`` for an input held constant over
   the step (zero-order hold), so it is stable for any Δt. It runs at the physics rate.
2. **Sampling** — the sensor is read at its catalogue ``rate_hz`` (an integer divisor of
   the 100 Hz physics rate, so a channel is *due* every ``100 / rate_hz`` steps).
3. **Noise** — Gaussian, 1-σ = ``noise`` (catalogue), from a seeded generator, so the same
   seed reproduces the same data.
4. **Quantisation** — rounding to the ADC / CAN resolution: ``round(v / res) · res``.
5. **Range clipping** — the sensor saturates at its physical ``min`` / ``max``.
   Compass angles (``gps_heading``) wrap modulo 360° instead of saturating.

Everything is vectorised over all channels with numpy: one lag update per step for every
channel, and one noise/quantise/clip pass per group of channels that share a rate.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence

import numpy as np

from aerovolt.core.model import ChannelDef

#: Channels whose value is an angle on a 0…360° circle (wrap instead of clip).
WRAPPING_CHANNELS = frozenset({"gps_heading"})


class VirtualSensorBank:
    """Lag, sample, add noise, quantise and clip a set of channels.

    Parameters
    ----------
    channels
        Channel definitions (normally ``catalog.raw_ids()`` in catalogue order).
    dt
        Physics step [s]. Every ``rate_hz`` must divide ``1/dt`` (100 Hz) exactly.
    rng
        Seeded numpy generator for the noise.
    """

    def __init__(self, channels: Sequence[ChannelDef], dt: float, rng: np.random.Generator) -> None:
        self.channels = list(channels)
        self.ids = [ch.id for ch in self.channels]
        self.index = {cid: i for i, cid in enumerate(self.ids)}
        self.dt = float(dt)
        self._rng = rng
        n = len(self.channels)
        lag = np.array([ch.lag_s for ch in self.channels], dtype=float)
        self.alpha = np.where(lag > 0.0, 1.0 - np.exp(-self.dt / np.maximum(lag, 1e-12)), 1.0)
        self.state = np.zeros(n)
        self._initialised = False

        steps_per_s = round(1.0 / self.dt)
        self.period_steps = np.empty(n, dtype=int)
        for i, ch in enumerate(self.channels):
            period = steps_per_s / ch.rate_hz
            if ch.rate_hz <= 0 or abs(period - round(period)) > 1e-9:
                raise ValueError(f"{ch.id}: rate {ch.rate_hz} Hz is not a divisor of {steps_per_s} Hz")
            self.period_steps[i] = round(period)

        # one sampling group per distinct period (e.g. 1, 2, 5, 10, 50, 100 steps)
        self._groups: list[_RateGroup] = []
        for period in sorted(set(self.period_steps.tolist())):
            idx = np.flatnonzero(self.period_steps == period)
            self._groups.append(_RateGroup(period, idx, [self.channels[i] for i in idx]))

    def reset(self, x: np.ndarray) -> None:
        """Start every lag filter at ``x`` (as if the sensors had been on for a while)."""
        self.state[:] = x
        self._initialised = True

    def update(self, x: np.ndarray) -> None:
        """Advance every lag filter by one physics step with the true values ``x``."""
        if not self._initialised:
            self.reset(x)
            return
        self.state += self.alpha * (x - self.state)

    def sample(self, step: int) -> dict[str, float]:
        """Measurements of every channel due at physics step ``step`` (noise, quantise, clip)."""
        out: dict[str, float] = {}
        for group in self._groups:
            if step % group.period == 0:
                out.update(group.measure(self.state, self._rng))
        return out

    def due_ids(self, step: int) -> list[str]:
        """Ids of the channels sampled at ``step`` (for tests and diagnostics)."""
        return [cid for g in self._groups if step % g.period == 0 for cid in g.ids]


class _RateGroup:
    """Channels sharing one sampling period, with their noise/quantisation/range arrays."""

    def __init__(self, period: int, idx: np.ndarray, channels: Sequence[ChannelDef]) -> None:
        self.period = int(period)
        self.idx = idx
        self.ids = [ch.id for ch in channels]
        self.noise = np.array([ch.noise for ch in channels], dtype=float)
        res = np.array([ch.resolution for ch in channels], dtype=float)
        self.quantised = res > 0.0
        self.res = np.where(self.quantised, res, 1.0)
        self.lo = np.array([ch.min for ch in channels], dtype=float)
        self.hi = np.array([ch.max for ch in channels], dtype=float)
        self.wrap = np.array([ch.id in WRAPPING_CHANNELS for ch in channels])
        self.any_noise = bool(np.any(self.noise > 0.0))
        self.any_wrap = bool(np.any(self.wrap))
        self.all_quantised = bool(np.all(self.quantised))

    def measure(self, state: np.ndarray, rng: np.random.Generator) -> Mapping[str, float]:
        v = state[self.idx]
        if self.any_noise:
            v = v + self.noise * rng.standard_normal(v.size)
        if self.any_wrap:
            v = np.where(self.wrap, np.mod(v, 360.0), v)
        q = np.round(v / self.res) * self.res
        v = q if self.all_quantised else np.where(self.quantised, q, v)
        if self.any_wrap:
            v = np.where(self.wrap, np.mod(v, 360.0), np.clip(v, self.lo, self.hi))
        else:
            v = np.clip(v, self.lo, self.hi)
        return dict(zip(self.ids, v.tolist()))


class OrnsteinUhlenbeck:
    """Random disturbance with a correlation time: gusts, road roughness, driver jitter.

    The Ornstein–Uhlenbeck process ``dx = −x/τ·dt + σ·√(2/τ)·dW`` is Gaussian noise that is
    *smooth* on time scales shorter than τ and *random* on longer ones, with stationary
    standard deviation σ. Its exact discretisation over a step Δt is::

        x[k+1] = x[k]·e^(−Δt/τ) + σ·√(1 − e^(−2Δt/τ))·N(0, 1)

    Normal deviates are drawn in blocks (one numpy call per 4096 steps) because the process
    is advanced with plain Python floats inside the physics loop.
    """

    BLOCK = 4096

    def __init__(self, sigma: float, tau_s: float, dt: float, rng: np.random.Generator) -> None:
        self.sigma = float(sigma)
        self._decay = float(np.exp(-dt / tau_s))
        self._gain = self.sigma * float(np.sqrt(1.0 - self._decay**2))
        self._rng = rng
        self._buf: list[float] = []
        self._i = 0
        self.value = 0.0

    def step(self) -> float:
        """Advance one step and return the new value."""
        if self._i >= len(self._buf):
            self._buf = self._rng.standard_normal(self.BLOCK).tolist()
            self._i = 0
        self.value = self.value * self._decay + self._gain * self._buf[self._i]
        self._i += 1
        return self.value
