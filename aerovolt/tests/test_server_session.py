"""Session (SPEC 9): data-time processing, fallback ticks, timeline, faults, logging, headless.

Uses scripted stub sources and a stub processor so the session's own logic is tested in
isolation (the real simulator + analysis are covered by test_server_integration.py).
"""

from __future__ import annotations

import asyncio
import math
from pathlib import Path
from typing import Any

import pytest
import yaml

from aerovolt.core.config import load_config
from aerovolt.core.manager import NoSimSourceError
from aerovolt.core.model import Alert, FaultInfo
from aerovolt.core.source import Source
from aerovolt.datalog.reader import read_log
from aerovolt.server import session as session_mod
from aerovolt.server.session import Session, _segment_path, expand_log_path


# --------------------------------------------------------------------------------------
# stubs
# --------------------------------------------------------------------------------------


class ScriptSource(Source):
    """Emits a fixed script of ``(t, values)``; ``t=None`` = stamp with ``ctx.clock()``."""

    def __init__(self, cfg: dict[str, Any], ctx: Any, script: list | None = None, hold: bool = False) -> None:
        super().__init__(cfg, ctx)
        self.kind = cfg.get("as_kind", "can")
        self.script = list(script or [])
        self.hold = hold

    async def run(self, emit):
        self.status = "running"
        for t, values in self.script:
            emit(self.ctx.clock() if t is None else t, values)
            await asyncio.sleep(0)
        self.status = "waiting"
        if self.hold:
            await asyncio.Event().wait()


class FakeSim(ScriptSource):
    """A 'sim' with two faults; ``gust`` switches itself on at t >= 0.5 (like a schedule)."""

    def __init__(self, cfg, ctx, script=None, hold=False):
        cfg = {**cfg, "as_kind": "sim"}
        super().__init__(cfg, ctx, script, hold)
        self.active = {"cell_hot": False, "gust": False}

    async def run(self, emit):
        self.status = "running"
        for t, values in self.script:
            if t >= 0.5:
                self.active["gust"] = True
            emit(t, values)
            await asyncio.sleep(0)
        self.status = "waiting"
        if self.hold:
            await asyncio.Event().wait()

    def faults(self):
        return [FaultInfo(fid, fid.title(), "powertrain", "test fault", on) for fid, on in self.active.items()]

    def set_fault(self, fault_id, active):
        if fault_id not in self.active:
            raise KeyError(fault_id)
        self.active[fault_id] = active


class StubProcessor:
    def __init__(self, ctx, store):
        self.ctx, self.store = ctx, store
        self.ticks: list[float] = []
        self.events: dict[float, list[dict]] = {}

    def tick(self, t):
        self.ticks.append(t)
        self.store.update(t, {"calc_q": t * 10.0})
        return self.events.pop(round(t, 2), [])


def write_config(tmp_path: Path, sources: list[dict], **extra: Any) -> Path:
    data = {"session": {"name": "test session", "log": extra.pop("log", None)},
            "processing": {"process_hz": 20, "snapshot_hz": 20, "history_s": 60},
            "sources": sources, **extra}
    path = tmp_path / "test.yaml"
    path.write_text(yaml.safe_dump(data), encoding="utf-8")
    return path


def make_session(tmp_path, script, kind="can", hold=False, source_cls=ScriptSource, **extra):
    cfg = load_config(write_config(tmp_path, [{"type": "stub", "as_kind": kind}], **extra))
    built: list[Any] = []
    processors: list[StubProcessor] = []

    def source_factory(c, ctx):
        src = source_cls(c, ctx, script, hold)
        built.append(src)
        return src

    def processor_factory(ctx, store):
        p = StubProcessor(ctx, store)
        processors.append(p)
        return p

    s = Session(cfg, processor_factory=processor_factory, source_factory=source_factory)
    return s, built, processors


def ramp(t_end: float, dt: float = 0.01, cid: str = "fw_p03"):
    n = int(round(t_end / dt))
    return [(i * dt, {cid: float(i)}) for i in range(n + 1)]


async def run_for(session: Session, until) -> None:
    await session.start()
    try:
        for _ in range(2000):
            if until():
                break
            await asyncio.sleep(0.005)
    finally:
        await session.stop()


# --------------------------------------------------------------------------------------
# tests
# --------------------------------------------------------------------------------------


def test_processing_and_snapshots_follow_data_time(tmp_path):
    s, _, procs = make_session(tmp_path, ramp(1.0), kind="sim")
    asyncio.run(run_for(s, lambda: s.t >= 1.0))
    ticks = procs[0].ticks
    assert len(ticks) == 21  # t = 0, 0.05, ..., 1.0 (data time, not wall time)
    assert ticks == pytest.approx([0.05 * k for k in range(21)])
    assert s.stats["snapshots"] == 21 and len(s.store) == 21
    t, series = s.store.history(["fw_p03", "calc_q"])
    assert series["fw_p03"][-1] == 100.0 and series["calc_q"][-1] == pytest.approx(10.0)
    assert s.mode == "SIM"


def test_a_time_gap_gives_one_tick_not_a_burst(tmp_path):
    s, _, procs = make_session(tmp_path, [(0.0, {"fw_p03": 1.0}), (3.0, {"fw_p03": 2.0}), (3.01, {"fw_p03": 3.0})],
                               kind="sim")
    asyncio.run(run_for(s, lambda: s.t >= 3.01))
    assert procs[0].ticks == pytest.approx([0.0, 3.0])


def test_session_clock_follows_data_time_when_a_sim_runs(tmp_path):
    s, _, _ = make_session(tmp_path, ramp(0.3), kind="sim")
    assert s.data_driven
    asyncio.run(run_for(s, lambda: s.t >= 0.3))
    assert s.ctx.clock() == pytest.approx(0.3)


def test_live_sources_use_wall_clock_and_fallback_ticks_detect_stale(tmp_path, monkeypatch):
    monkeypatch.setattr(session_mod, "FALLBACK_PERIOD_S", 0.05)
    s, _, procs = make_session(tmp_path, [(None, {"fw_p03": 5.0, "amb_temp": 18.0})], kind="can", hold=True)
    assert not s.data_driven

    async def main():
        await s.start()
        try:
            await asyncio.sleep(0.8)
            frame = s.frame()
            assert "fw_p03" in frame.get("stale", [])  # 50 Hz channel silent for > 0.5 s
            assert "amb_temp" not in frame.get("stale", [])  # 1 Hz channel: stale after 5 s
        finally:
            await s.stop()

    asyncio.run(main())
    assert s.stats["fallback_ticks"] >= 5  # ~ every 50 ms (patched from 1 s) without data
    assert procs[0].ticks == sorted(procs[0].ticks)
    assert s.mode == "LIVE"


def test_events_build_the_timeline_and_are_published(tmp_path):
    s, _, procs = make_session(tmp_path, ramp(1.0), kind="sim")
    raised = Alert("bms_cell_overtemp", "bms_cell_overtemp", "critical", "Cell over-temperature",
                   "cell 47 at 61.2 °C", ["cell_t_20"], 0.2)
    cleared = Alert("bms_cell_overtemp", "bms_cell_overtemp", "critical", "Cell over-temperature",
                    "cell 47 at 55 °C", ["cell_t_20"], 0.2, t_end=0.6, active=False)
    other = Alert("aero_high_yaw", "aero_high_yaw", "warn", "High yaw", "12 deg", ["probe_yaw"], 0.4)
    procs[0].events = {
        0.2: [{"type": "alert", "alert": raised.to_json()}],
        0.4: [{"type": "alert", "alert": other.to_json()}],
        0.6: [{"type": "alert", "alert": cleared.to_json()},
              {"type": "lap", "lap": {"lap": 1, "lap_time": 58.6}},
              {"type": "strategy", "strategy": {"recommended_kw": 60}}],
    }
    seen: list[dict] = []
    s.bus.subscribe(seen.append)
    asyncio.run(run_for(s, lambda: s.t >= 1.0))
    assert [e["type"] for e in seen] == ["alert", "alert", "alert", "lap", "strategy"]
    log = s.alerts_json()
    assert [a["id"] for a in log] == ["bms_cell_overtemp", "aero_high_yaw"]
    assert log[0]["active"] is False and log[0]["t_end"] == 0.6
    assert [a["id"] for a in s.alerts_json(active_only=True)] == ["aero_high_yaw"]
    assert s.laps == [{"lap": 1, "lap_time": 58.6}]
    assert s.strategy == {"recommended_kw": 60}
    hello = s.hello()
    assert hello["type"] == "hello" and hello["version"] == "1.0" and hello["mode"] == "SIM"
    assert [a["id"] for a in hello["alerts"]] == ["aero_high_yaw"]
    assert hello["laps"] == s.laps and hello["strategy"] == s.strategy
    assert hello["session"]["name"] == "test session" and hello["session"]["started"]
    assert len(hello["channels"]) == len(s.catalog) and hello["track"] is None


def test_faults_without_a_sim(tmp_path):
    s, _, _ = make_session(tmp_path, [], kind="can")
    assert s.faults() == []
    with pytest.raises(NoSimSourceError):
        s.set_fault("cell_hot", True)


def test_fault_timeline_user_and_sim_changes(tmp_path):
    s, _, _ = make_session(tmp_path, ramp(1.0), kind="sim", source_cls=FakeSim, hold=True)
    published: list[dict] = []
    s.bus.subscribe(published.append, types=["faults"])

    async def main():
        await s.start()
        try:
            while s.t < 1.0:
                await asyncio.sleep(0.005)
            faults = s.set_fault("cell_hot", True)
            assert {f["id"]: f["active"] for f in faults} == {"cell_hot": True, "gust": True}
            with pytest.raises(KeyError):
                s.set_fault("nope", True)
        finally:
            await s.stop()

    asyncio.run(main())
    assert s.fault_timeline == [{"t": 0.5, "id": "gust", "active": True, "by": "sim"},
                                {"t": 1.0, "id": "cell_hot", "active": True, "by": "user"}]
    assert len(published) == 2 and published[-1]["faults"][0]["active"] is True


def test_frame_rounding_nan_and_owner(tmp_path):
    s, _, _ = make_session(tmp_path, [(0.0, {"fw_p03": -412.54321, "cell_v_000": 3.91234567,
                                             "amb_temp": float("nan")})], kind="sim")
    asyncio.run(run_for(s, lambda: s.t >= 0.0 and s.stats["ticks"] > 0))
    frame = s.frame()
    assert frame["type"] == "frame" and frame["t"] == 0.0
    assert frame["v"]["fw_p03"] == -412.54  # 0.1 Pa resolution + one guard digit
    assert frame["v"]["cell_v_000"] == 3.9123  # 1 mV + one guard digit
    assert frame["v"]["amb_temp"] is None
    assert frame["owner"] == {}
    hist = s.history(["fw_p03", "no_such"], 10)
    assert hist["t"] == [0.0] and hist["series"]["fw_p03"] == [-412.54] and hist["series"]["no_such"] == [None]


def test_time_jump_back_starts_a_new_session(tmp_path):
    script = ramp(8.0, dt=0.05) + [(0.0, {"fw_p03": -1.0}), (0.05, {"fw_p03": -2.0})]
    s, _, _ = make_session(tmp_path, script, kind="replay")
    events: list[dict] = []
    s.bus.subscribe(events.append, types=["reset"])
    asyncio.run(run_for(s, lambda: s.stats.get("time_resets", 0) >= 1 and s.store.latest("fw_p03") == -2.0))
    assert s.stats["time_resets"] == 1 and len(events) == 1
    assert s.t == pytest.approx(0.05)
    t, series = s.store.history(["fw_p03"])
    assert t.tolist() == pytest.approx([0.0, 0.05]) and series["fw_p03"].tolist() == [-1.0, -2.0]
    assert s.mode == "REPLAY"


def test_logging_writes_rows_meta_and_blanks_dead_sensors(tmp_path):
    log_path = tmp_path / "logs" / "run_{timestamp}.csv.gz"
    script = [(i * 0.05, {"fw_p03": float(i), **({"amb_temp": 18.0} if i == 0 else {})}) for i in range(10)]
    script += [(0.5 + i * 0.05, {"amb_temp": 18.0}) for i in range(20)]  # fw_p03 dies at 0.45 s
    s, _, procs = make_session(tmp_path, script, kind="sim", log=str(log_path))
    procs[0].events = {0.2: [{"type": "lap", "lap": {"lap": 1, "lap_time": 1.0}}]}
    summary = asyncio.run(s.run_headless(duration=1.45))
    logs = sorted((tmp_path / "logs").glob("run_*.csv.gz"))
    assert len(logs) == 1 and summary["log"] == str(logs[0])
    log = read_log(logs[0])
    assert len(log) == s.stats["snapshots"] == 30
    assert log["fw_p03"][9] == 9.0  # t = 0.45: live
    assert log["fw_p03"][19] == 9.0  # t = 0.95: 0.5 s old, still within max(0.5, 5/50 Hz)
    assert math.isnan(log["fw_p03"][-1])  # t = 1.45: dead for 1 s -> empty cell, not frozen
    assert log["calc_q"][-1] == pytest.approx(14.5)
    assert log.meta["laps"] == [{"lap": 1, "lap_time": 1.0}]
    assert log.meta["mode"] == "SIM" and "ended" in log.meta and log.meta["duration_s"] == 1.45
    assert summary["duration_s"] == 1.45 and summary["laps"] == [{"lap": 1, "lap_time": 1.0}]
    assert "calc_soc_ekf" in summary["final"]


def test_headless_ends_when_the_data_sources_finish(tmp_path, monkeypatch):
    monkeypatch.setattr(session_mod, "HEADLESS_IDLE_S", 0.05)
    s, _, _ = make_session(tmp_path, ramp(0.5), kind="replay")
    summary = asyncio.run(asyncio.wait_for(s.run_headless(), 10))
    assert summary["duration_s"] == 0.5 and summary["mode"] == "REPLAY"
    assert not s.running


def test_headless_duration_cuts_data_exactly(tmp_path):
    s, _, procs = make_session(tmp_path, ramp(2.0), kind="sim")
    summary = asyncio.run(s.run_headless(duration=1.0))
    assert summary["duration_s"] == 1.0
    assert max(procs[0].ticks) == pytest.approx(1.0)


def test_reset_rebuilds_sources_and_clears_the_timeline(tmp_path):
    s, built, procs = make_session(tmp_path, ramp(0.5), kind="sim", hold=True)
    resets: list[dict] = []
    s.bus.subscribe(resets.append, types=["reset"])
    procs[0].events = {0.1: [{"type": "lap", "lap": {"lap": 1}}]}

    async def main():
        await s.start()
        try:
            while s.t < 0.5:
                await asyncio.sleep(0.005)
            assert s.laps
            await s.reset()
            assert s.running and s.laps == [] and len(built) == 2 and len(procs) == 2
            for _ in range(400):
                if procs[1].ticks:
                    break
                await asyncio.sleep(0.005)
        finally:
            await s.stop()

    asyncio.run(main())
    assert resets == [{"type": "reset"}]
    assert procs[1].ticks and procs[1].ticks[0] == 0.0


def test_venue_track_for_real_sources(tmp_path):
    s, _, _ = make_session(tmp_path, [], kind="can", track="skidpad")
    assert s.track is not None and s.track.name == "skidpad" and s.hello()["track"]["name"] == "skidpad"
    s, _, _ = make_session(tmp_path, [], kind="can", track="skidpad", laps={"gate": [[52.0, -1.0], [52.0, -1.0001]]})
    assert s.track is None  # a configured gate means a venue AeroVolt does not know
    s, _, _ = make_session(tmp_path, [], kind="can", track=None)
    assert s.track is None


def test_log_path_helpers():
    from datetime import datetime

    when = datetime(2026, 10, 2, 15, 30, 12)
    assert expand_log_path(Path("logs/car_{timestamp}.csv.gz"), when) == Path("logs/car_20261002-153012.csv.gz")
    assert expand_log_path(Path("logs/a.csv"), when) == Path("logs/a.csv")
    assert _segment_path(Path("logs/run.csv.gz"), 1) == Path("logs/run.csv.gz")
    assert _segment_path(Path("logs/run.csv.gz"), 2) == Path("logs/run-2.csv.gz")
    assert _segment_path(Path("logs/run.csv"), 3) == Path("logs/run-3.csv")


def test_tick_boundaries_tolerate_float_accumulation(tmp_path):
    t, script = 0.0, []
    for i in range(101):  # sim-style time: repeated addition of 0.01 drifts below k * 0.05
        script.append((t, {"fw_p03": float(i)}))
        t += 0.01
    s, _, procs = make_session(tmp_path, script, kind="sim")
    asyncio.run(run_for(s, lambda: s.stats["emissions"] >= 101))
    assert len(procs[0].ticks) == 21
    assert procs[0].ticks == pytest.approx([0.05 * k for k in range(21)], abs=1e-9)
