"""SimSource (sim/source.py): registry, config, asyncio pacing, faults via the manager."""

import asyncio
import time

import pytest

from aerovolt.core.config import load_config
from aerovolt.core.manager import SourceManager
from aerovolt.core.source import SessionContext, create_source, registered_sources
from aerovolt.sim.source import SimSource


@pytest.fixture(scope="module")
def config():
    return load_config("config/demo.yaml")


def make_source(config, **overrides):
    cfg = {**config.sources[0], **overrides}
    ctx = SessionContext(config=config, catalog=config.catalog, vehicle=config.vehicle, root=config.root)
    return create_source(cfg, ctx), ctx


def test_registered_as_sim_and_sets_the_track(config):
    src, ctx = make_source(config)
    assert isinstance(src, SimSource) and registered_sources()["sim"] is SimSource
    assert src.kind == "sim" and src.label == "Simulator"
    assert ctx.track is src.engine.track and ctx.track.name == "fs_endurance"
    assert src.provides() is None
    info = src.info()
    assert info["kind"] == "sim" and "fs_endurance" in info["detail"]


def test_config_keys_reach_the_engine(config):
    src, ctx = make_source(config, track="skidpad", seed=9, laps=3, start_soc=70, start_temp_c=31.0,
                           power_limit_kw=60.0, speed="max",
                           faults=[{"id": "cell_hot", "t": 5.0}, "tap_leak@7"],
                           weather={**config.sources[0]["weather"], "temp_c": 12.0})
    eng = src.engine
    assert ctx.track.name == "skidpad" and eng.seed == 9 and eng.laps_limit == 3
    assert eng.truth()["truth_soc"] == pytest.approx(70.0)
    assert eng.powertrain.pack.temp.mean() == pytest.approx(31.0)
    assert eng.powertrain.power_limit_w == pytest.approx(60_000.0)
    assert eng.weather.temp_c == 12.0
    assert src.speed == "max"
    eng.run_offline(8.0)
    assert {f.id for f in src.faults() if f.active} == {"cell_hot", "tap_leak"}


def test_max_speed_runs_to_the_lap_limit_and_yields(config):
    src, _ = make_source(config, speed="max", laps=1, weather={**config.sources[0]["weather"], "wind_ms": 0.0})
    calls, ticks = [], []

    async def main():
        async def ticker():  # proves the event loop is not blocked
            while True:
                ticks.append(time.perf_counter())
                await asyncio.sleep(0)

        task = asyncio.create_task(ticker())
        await src.run(lambda t, v: calls.append((t, len(v))))
        task.cancel()

    asyncio.run(main())
    assert src.engine.finished and src.engine.lap == 2
    assert calls[0] == (0.0, 309)  # full first sample: 298 raw + 11 truth channels
    assert len(ticks) > 100
    assert src.stats["lap"] == 2 and src.stats["realtime_factor"] > 10.0
    assert "finished" in src.detail and src.status == "waiting"


def test_paced_run_follows_wall_clock(config):
    src, _ = make_source(config, speed=10.0)
    samples = []

    async def main():
        task = asyncio.create_task(src.run(lambda t, v: samples.append(t)))
        await asyncio.sleep(0.6)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    wall0 = time.perf_counter()
    asyncio.run(main())
    wall = time.perf_counter() - wall0
    assert src.status == "running"
    assert src.engine.t == pytest.approx(10.0 * wall, rel=0.25)
    assert samples == sorted(samples)  # monotonic session time


def test_faults_through_the_source_manager(config):
    src, _ = make_source(config, speed="max")
    mgr = SourceManager([src], config.catalog)
    faults = mgr.set_fault("pump_fail", True)
    assert any(f.id == "pump_fail" and f.active for f in faults)
    assert src.engine.powertrain.cooling.pump_failed
    mgr.set_fault("pump_fail", False)
    assert not src.engine.powertrain.cooling.pump_failed
    with pytest.raises(KeyError):
        mgr.set_fault("warp_drive", True)


def test_manager_merges_sim_data(config):
    src, _ = make_source(config, speed="max", laps=None)
    mgr = SourceManager([src], config.catalog)
    received = {}

    async def main():
        await mgr.start(lambda t, v: received.update(v))
        await asyncio.sleep(0.3)
        await mgr.stop()

    asyncio.run(main())
    assert set(config.catalog.raw_ids()) <= set(received)
    assert mgr.mode == "SIM" and mgr.owner("fw_p01") == "sim"
    assert mgr.stats["unknown"] == 0
