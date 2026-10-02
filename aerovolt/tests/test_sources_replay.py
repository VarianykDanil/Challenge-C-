"""ReplaySource: plays datalog files back (SPEC 7.4)."""

from __future__ import annotations

import asyncio
import math
import time

import pytest

from aerovolt.core.config import load_config
from aerovolt.core.source import SessionContext, SourceError, create_source
from aerovolt.datalog.writer import write_log
from aerovolt.sources.replay_source import track_from_meta


@pytest.fixture(scope="module")
def config():
    return load_config(None)


def make_ctx(config) -> SessionContext:
    return SessionContext(config=config, catalog=config.catalog, vehicle=config.vehicle, root=config.root)


def make_log(tmp_path, catalog, n=40, meta=None, name="run.csv.gz"):
    channels = [catalog["fw_p03"], catalog["amb_temp"], catalog["truth_speed"], catalog["calc_cla"]]
    rows = [[-400.0 + i, 18.0 if i % 2 == 0 else math.nan, 20.0 + i, 3.5] for i in range(n)]
    path = tmp_path / name
    write_log(path, channels, [10.0 + 0.05 * i for i in range(n)], rows, meta=meta)
    return path


def collect(src, timeout=10.0):
    out: list[tuple[float, dict[str, float]]] = []

    async def main():
        await asyncio.wait_for(src.run(lambda t, v: out.append((t, dict(v)))), timeout)

    t0 = time.perf_counter()
    asyncio.run(main())
    return out, time.perf_counter() - t0


def test_replay_at_max_speed_emits_measured_channels_only(tmp_path, config):
    path = make_log(tmp_path, config.catalog, meta={"track": {"name": "skidpad"}})
    ctx = make_ctx(config)
    src = create_source({"type": "replay", "file": str(path), "speed": "max"}, ctx)
    assert src.kind == "replay" and src.columns == ["fw_p03", "amb_temp", "truth_speed"]
    assert ctx.track is not None and ctx.track.name == "skidpad"  # from the meta sidecar
    out, _ = collect(src)
    assert len(out) == 40
    assert out[0][0] == pytest.approx(10.0) and out[-1][0] == pytest.approx(11.95)  # log time
    assert out[0][1] == {"fw_p03": -400.0, "amb_temp": 18.0, "truth_speed": 20.0}
    assert out[1][1] == {"fw_p03": -399.0, "truth_speed": 21.0}  # empty cell: not emitted
    assert all("calc_cla" not in v for _, v in out)  # the analysis recomputes calc_*
    assert src.status == "waiting" and "finished" in src.detail
    assert src.stats["rows"] == 40 and src.stats["duration_s"] == pytest.approx(1.95)


def test_replay_paced_speed_and_start_offset(tmp_path, config):
    path = make_log(tmp_path, config.catalog, n=21)  # 1.0 s of data
    src = create_source({"type": "replay", "file": str(path), "speed": 4.0, "start_s": 10.5}, make_ctx(config))
    out, wall = collect(src)
    assert out[0][0] == pytest.approx(10.5)
    assert len(out) == 11
    assert 0.10 <= wall < 0.6  # 0.5 s of log at 4x real time ~ 0.125 s


def test_replay_loop_restarts_the_log(tmp_path, config):
    path = make_log(tmp_path, config.catalog, n=5)
    src = create_source({"type": "replay", "file": str(path), "speed": "max", "loop": True}, make_ctx(config))
    out: list[float] = []

    async def main():
        task = asyncio.create_task(src.run(lambda t, v: out.append(t)))
        while len(out) < 12:
            await asyncio.sleep(0.001)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    asyncio.run(main())
    assert out[:6] == pytest.approx([10.0, 10.05, 10.1, 10.15, 10.2, 10.0])
    assert src.stats["loops"] >= 2


def test_relative_path_resolves_against_project_root_and_errors(tmp_path, config):
    ctx = make_ctx(config)
    with pytest.raises(SourceError, match="not found"):
        create_source({"type": "replay", "file": "logs/definitely_missing.csv.gz"}, ctx)
    with pytest.raises(SourceError, match="needs 'file"):
        create_source({"type": "replay"}, ctx)
    bad = tmp_path / "bad.csv"
    bad.write_text("x,y\n")
    with pytest.raises(SourceError):
        create_source({"type": "replay", "file": str(bad)}, ctx)
    good = make_log(tmp_path, config.catalog)
    with pytest.raises(SourceError, match="speed"):
        create_source({"type": "replay", "file": str(good), "speed": 0}, ctx)


def test_track_from_meta():
    assert track_from_meta({}) is None
    assert track_from_meta({"track": None}) is None
    assert track_from_meta({"track": {"name": "fs_endurance"}}).name == "fs_endurance"
    # An unknown venue is rebuilt from its logged centreline.
    square = [[0, 0], [60, 0], [60, 40], [0, 40]]
    custom = track_from_meta({"track": {"name": "my_carpark", "closed": True, "xy": square}})
    assert custom is not None and custom.name == "my_carpark" and custom.closed
    assert 150 < custom.length < 260
