"""``SimSource``: the simulator as a data source (``type: sim`` in the config).

It wraps a :class:`~aerovolt.sim.engine.SimEngine` and paces it against the wall clock:
``speed: 1.0`` is real time, ``speed: 4`` four times faster, ``speed: max`` as fast as the CPU
allows (yielding to the event loop every :data:`MAX_SPEED_BATCH` steps so the web server
stays responsive). If the computer cannot keep up with the requested speed, the backlog is
dropped instead of letting the sim fall further and further behind (``stats.overruns``).

Config keys (all optional; ``core.config`` fills the defaults)::

    - type: sim
      label: Simulator
      track: fs_endurance        # fs_endurance | skidpad | acceleration
      speed: 1.0                 # float or "max"
      seed: 42                   # same seed → same driver variation, cell spread and noise
      weather: {temp_c, pressure_pa, rh_pct, wind_ms, wind_dir_deg (from)}
      faults: ["cell_hot@60"]    # scheduled activations (id@seconds)
      laps: null                 # stop after this many completed laps
      start_soc: 100             # accumulator state of charge at the start [%]
      start_temp_c: null         # cells / motor / coolant start temperature (default: ambient)
      power_limit_kw: null       # accumulator power limit (default: vehicle.yaml, 80 kW)
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from aerovolt.core.model import Emit, FaultInfo
from aerovolt.core.source import SessionContext, Source, register_source
from aerovolt.sim.engine import SimEngine

#: Steps computed between event-loop yields at ``speed: max``.
MAX_SPEED_BATCH = 50
#: Largest backlog of sim time [s] the paced loop catches up; more is dropped.
MAX_BACKLOG_S = 0.5
#: Longest sleep between batches in the paced loop [s].
MAX_SLEEP_S = 0.02


@register_source("sim")
class SimSource(Source):
    """The virtual car as a :class:`~aerovolt.core.source.Source` (see module docstring)."""

    default_label = "Simulator"

    def __init__(self, cfg: dict[str, Any], ctx: SessionContext) -> None:
        super().__init__(cfg, ctx)
        default_track = getattr(ctx.config, "track", None) or "fs_endurance"
        self.engine = SimEngine.from_config(self.cfg, ctx.vehicle, ctx.catalog, default_track)
        ctx.track = self.engine.track
        speed = self.cfg.get("speed", 1.0)
        self.speed: float | str = "max" if str(speed).lower() == "max" else float(speed)
        self._started = False
        self.stats = {"sim_time": 0.0, "lap": 0, "steps": 0, "realtime_factor": 0.0, "overruns": 0}
        self._update_detail()

    # ------------------------------------------------------------------ Source API
    async def run(self, emit: Emit) -> None:
        """Run the engine until cancelled (or until the configured lap limit is reached)."""
        engine = self.engine
        self.status = "running"
        if not self._started:
            self._started = True
            emit(engine.t, engine.sample_all())
        if self.speed == "max":
            await self._run_max(emit)
        else:
            await self._run_paced(emit, float(self.speed))
        self.status = "waiting"
        self.detail = f"{engine.track.name}: finished after {engine.laps_limit} laps"

    def faults(self) -> list[FaultInfo]:
        return self.engine.fault_infos()

    def set_fault(self, fault_id: str, active: bool) -> None:
        """Toggle a fault (``KeyError`` for an unknown id)."""
        self.engine.set_fault(fault_id, active)

    # ------------------------------------------------------------------ loops
    async def _run_max(self, emit: Emit) -> None:
        engine = self.engine
        wall0, sim0 = time.perf_counter(), engine.t
        while not engine.finished:
            for _ in range(MAX_SPEED_BATCH):
                values = engine.step()
                if values:
                    emit(engine.t, values)
                if engine.finished:
                    break
            self._update_stats(wall0, sim0)
            await asyncio.sleep(0)

    async def _run_paced(self, emit: Emit, speed: float) -> None:
        engine = self.engine
        loop = asyncio.get_running_loop()
        wall0, sim0 = loop.time(), engine.t
        stats_wall0, stats_sim0 = time.perf_counter(), engine.t
        dt = engine.dt
        while not engine.finished:
            target = sim0 + (loop.time() - wall0) * speed
            if target - engine.t > MAX_BACKLOG_S:  # cannot keep up: drop the backlog
                self.stats["overruns"] += 1
                wall0, sim0 = loop.time(), engine.t
                target = engine.t
            while engine.t + 0.5 * dt <= target and not engine.finished:
                values = engine.step()
                if values:
                    emit(engine.t, values)
            self._update_stats(stats_wall0, stats_sim0)
            next_step_wall = wall0 + (engine.t + dt - sim0) / speed
            await asyncio.sleep(min(max(next_step_wall - loop.time(), 0.0), MAX_SLEEP_S))

    # ------------------------------------------------------------------ status
    def _update_stats(self, wall0: float, sim0: float) -> None:
        engine = self.engine
        wall = time.perf_counter() - wall0
        self.stats.update(
            sim_time=round(engine.t, 2),
            lap=engine.lap,
            steps=engine.step_index,
            realtime_factor=round((engine.t - sim0) / wall, 1) if wall > 0 else 0.0,
        )
        self._update_detail()

    def _update_detail(self) -> None:
        speed = "max" if self.speed == "max" else f"×{self.speed:g}"
        self.detail = f"{self.engine.track.name} {speed} · lap {self.engine.lap}"
