"""Tests for aerovolt.core.source (registry) and aerovolt.core.manager (merging)."""

import asyncio
import math
import sys
import textwrap
from pathlib import Path

import pytest

from aerovolt.core import source as source_mod
from aerovolt.core.catalog import Catalog
from aerovolt.core.config import Calibration
from aerovolt.core.manager import NoSimSourceError, SourceManager
from aerovolt.core.model import ChannelDef, FaultInfo
from aerovolt.core.source import (
    MissingDependencyError,
    SessionClock,
    SessionContext,
    Source,
    SourceError,
    UnknownSourceError,
    create_source,
    import_hardware,
    register_source,
)

CATALOG = Catalog([
    ChannelDef("fw_p03", "tap", "Pa", "aero", "aero.taps", 50, -3000, 3000,
               meta={"element": "fw", "station": "L", "surface": "suction", "x_c": 0.45}),
    ChannelDef("amb_temp", "T", "°C", "aero", "aero.air", 1, -20, 60),
    ChannelDef("calc_q", "q", "Pa", "calc", "calc.aero", 20, 0, 3000, derived=True),
])


def make_ctx() -> SessionContext:
    return SessionContext(config=None, catalog=CATALOG, vehicle={}, root=Path("."))


class FakeSource(Source):
    """Emits a scripted list of value dicts, one per tick, then idles."""

    def __init__(self, kind, script=(), cfg=None, period=0.001):
        super().__init__(cfg or {}, make_ctx())
        self.kind = kind
        self.script = list(script)
        self.period = period

    async def run(self, emit):
        self.status = "running"
        for k, values in enumerate(self.script):
            emit(float(k), values)
            await asyncio.sleep(self.period)
        await asyncio.Event().wait()


class FakeClock:
    def __init__(self):
        self.now = 100.0

    def __call__(self):
        return self.now


def manager_with(*sources, calibration=None, clock=None):
    received = []
    mgr = SourceManager(list(sources), CATALOG, calibration, clock=clock or FakeClock())
    mgr._sink = lambda t, v: received.append((t, v))
    return mgr, received


# ---------------------------------------------------------------------------- merging


def test_later_source_overrides_within_window_then_sim_returns():
    clock = FakeClock()
    sim, serial = FakeSource("sim"), FakeSource("serial")
    mgr, got = manager_with(sim, serial, clock=clock)
    sim_emit, serial_emit = mgr._emitters

    sim_emit(0.0, {"fw_p03": -400.0, "amb_temp": 18.0})
    assert got[-1][1] == {"fw_p03": -400.0, "amb_temp": 18.0}
    assert mgr.owner("fw_p03") == "sim"

    serial_emit(0.1, {"fw_p03": -390.0})
    assert got[-1][1] == {"fw_p03": -390.0}
    assert mgr.owner("fw_p03") == "serial"
    assert mgr.owner_overrides() == {"fw_p03": "serial"}

    clock.now += 0.5  # serial still fresh -> sim tap value dropped, ambient passes
    sim_emit(0.6, {"fw_p03": -401.0, "amb_temp": 18.1})
    assert got[-1][1] == {"amb_temp": 18.1}
    assert mgr.stats["overridden"] == 1

    clock.now += 0.6  # 1.1 s since the serial value: the simulated value comes back
    sim_emit(1.2, {"fw_p03": -402.0})
    assert got[-1][1] == {"fw_p03": -402.0}
    assert mgr.owner("fw_p03") == "sim"
    assert mgr.owner_overrides() == {}
    assert mgr.owners() == {"fw_p03": "sim", "amb_temp": "sim"}


def test_earlier_source_never_overrides_later_one():
    mgr, got = manager_with(FakeSource("sim"), FakeSource("serial"))
    mgr._emitters[1](0.0, {"fw_p03": 1.0})
    mgr._emitters[0](0.0, {"fw_p03": 2.0})
    mgr._emitters[1](0.0, {"fw_p03": 3.0})
    assert [v for _, v in got] == [{"fw_p03": 1.0}, {"fw_p03": 3.0}]


def test_calibration_only_for_hardware_sources():
    cal = {"fw_p03": Calibration(offset=10.0, scale=2.0)}
    for kind, expected in (("sim", 30.0), ("replay", 30.0), ("serial", 40.0), ("can", 40.0)):
        mgr, got = manager_with(FakeSource(kind), calibration=cal)
        mgr._emitters[0](0, {"fw_p03": 30.0, "amb_temp": 5.0})
        assert got[-1][1] == {"fw_p03": pytest.approx(expected), "amb_temp": 5.0}, kind


def test_unknown_derived_invalid_and_provides_filtering():
    serial = FakeSource("serial", cfg={"channels": ["fw_p03"]})
    mgr, got = manager_with(serial)
    mgr._emitters[0](0, {"fw_p03": 1, "amb_temp": 2, "nope": 3, "calc_q": 4})
    mgr._emitters[0](0, {"fw_p03": "garbage", "nope": 5, "other": 6})
    assert got == [(0, {"fw_p03": 1.0})]
    assert mgr.stats["unknown"] == 3 and mgr.stats["unknown_ids"] == ["nope", "other"]
    assert mgr.stats["derived_dropped"] == 1
    assert mgr.stats["not_provided"] == 1
    assert mgr.stats["invalid"] == 1
    info = mgr.info()[0]
    assert info["stats"]["unknown"] == 3 and info["stats"]["accepted"] == 1
    mgr.reset_stats()
    assert mgr.stats["unknown"] == 0 and mgr.owner("fw_p03") is None


def test_nan_values_pass_through():
    mgr, got = manager_with(FakeSource("serial"))
    mgr._emitters[0](0, {"fw_p03": float("nan")})
    assert math.isnan(got[0][1]["fw_p03"])


def test_mode():
    def mode(*kinds):
        return SourceManager([FakeSource(k) for k in kinds], CATALOG).mode

    assert mode("sim") == "SIM"
    assert mode("serial") == "LIVE"
    assert mode("can", "serial") == "LIVE"
    assert mode("sim", "serial") == "HYBRID"
    assert mode("replay") == "REPLAY"
    with pytest.raises(ValueError):
        SourceManager([], CATALOG)


# ---------------------------------------------------------------------------- lifecycle


def test_sources_run_as_tasks_and_merge():
    async def scenario():
        sim = FakeSource("sim", [{"fw_p03": -1.0}, {"amb_temp": 17.0}])
        serial = FakeSource("serial", [{"fw_p03": -2.0}])
        mgr = SourceManager([sim, serial], CATALOG)
        got = []
        await mgr.start(lambda t, v: got.append(v))
        await asyncio.sleep(0.05)
        info = mgr.info()
        await mgr.stop()
        return got, info, mgr

    got, info, mgr = asyncio.run(scenario())
    assert {"amb_temp": 17.0} in got and {"fw_p03": -2.0} in got
    assert [i["status"] for i in info] == ["running", "running"]
    assert [i["priority"] for i in info] == [0, 1]
    assert not mgr.running


class CrashingSource(FakeSource):
    def __init__(self):
        super().__init__("serial")
        self.runs = 0

    async def run(self, emit):
        self.runs += 1
        if self.runs == 1:
            raise OSError("port vanished")
        self.status = "running"
        emit(0.0, {"fw_p03": 7.0})
        await asyncio.Event().wait()


def test_crashing_source_is_restarted_and_reported():
    async def scenario():
        src = CrashingSource()
        mgr = SourceManager([FakeSource("sim"), src], CATALOG, restart_delay_s=0.1)
        got = []
        await mgr.start(lambda t, v: got.append(v))
        await asyncio.sleep(0.03)
        during = mgr.info()[1]
        await asyncio.sleep(0.15)
        after = mgr.info()[1]
        await mgr.stop()
        return src, got, during, after

    src, got, during, after = asyncio.run(scenario())
    assert during["status"] == "error" and "port vanished" in during["detail"]
    assert src.runs == 2
    assert {"fw_p03": 7.0} in got
    assert after["status"] == "running" and after["stats"]["restarts"] == 1


def test_failing_sink_does_not_kill_the_source():
    async def scenario():
        src = FakeSource("sim", [{"fw_p03": 1.0}, {"fw_p03": 2.0}])
        mgr = SourceManager([src], CATALOG)

        def sink(t, v):
            raise ValueError("processing bug")

        await mgr.start(sink)
        await asyncio.sleep(0.03)
        state = mgr.info()[0]["status"]
        await mgr.stop()
        return state, mgr

    state, mgr = asyncio.run(scenario())
    assert state == "running" and mgr._sink_errors == 2


def test_finished_source_reports_waiting():
    class OneShot(FakeSource):
        async def run(self, emit):
            emit(0.0, {"amb_temp": 1.0})

    async def scenario():
        mgr = SourceManager([OneShot("replay")], CATALOG)
        await mgr.start(lambda t, v: None)
        await asyncio.sleep(0.02)
        info = mgr.info()[0]
        await mgr.stop()
        return info

    info = asyncio.run(scenario())
    assert info["status"] == "waiting" and info["detail"] == "finished"


# ---------------------------------------------------------------------------- faults


class FakeSim(FakeSource):
    def __init__(self):
        super().__init__("sim")
        self._faults = {"cell_hot": FaultInfo("cell_hot", "Hot cell", "powertrain", "R0 x4")}

    def faults(self):
        return list(self._faults.values())

    def set_fault(self, fault_id, active):
        self._faults[fault_id].active = active


def test_faults_delegate_to_sim_or_raise():
    mgr = SourceManager([FakeSim(), FakeSource("serial")], CATALOG)
    assert mgr.set_fault("cell_hot", True)[0].active is True
    assert mgr.faults()[0].active is True
    with pytest.raises(KeyError):
        mgr.set_fault("nope", True)
    live = SourceManager([FakeSource("can")], CATALOG)
    with pytest.raises(NoSimSourceError):
        live.faults()
    with pytest.raises(NoSimSourceError):
        live.set_fault("cell_hot", True)
    with pytest.raises(NotImplementedError):
        FakeSource("can").set_fault("x", True)
    assert FakeSource("can").faults() == []


# ---------------------------------------------------------------------------- registry


@pytest.fixture()
def fake_modules(tmp_path, monkeypatch):
    (tmp_path / "av_fake_source.py").write_text(textwrap.dedent("""
        from aerovolt.core.source import Source, register_source

        @register_source("fake")
        class FakeKind(Source):
            default_label = "Fake"
            async def run(self, emit):
                pass
    """))
    (tmp_path / "av_needs_serial.py").write_text(
        "raise ModuleNotFoundError(\"No module named 'serial'\", name='serial')\n")
    (tmp_path / "av_forgot_register.py").write_text("X = 1\n")
    (tmp_path / "av_broken.py").write_text("import av_this_module_does_not_exist\n")
    monkeypatch.syspath_prepend(str(tmp_path))
    modules = dict(source_mod.SOURCE_MODULES, fake="av_fake_source", needs_hw="av_needs_serial",
                   unregistered="av_forgot_register", broken="av_broken")
    monkeypatch.setattr(source_mod, "SOURCE_MODULES", modules)
    yield
    for name in ("av_fake_source", "av_needs_serial", "av_forgot_register", "av_broken"):
        sys.modules.pop(name, None)
    source_mod._REGISTRY.pop("fake", None)


def test_create_source_lazy_import_and_registration(fake_modules):
    src = create_source({"type": "fake", "label": "My fake"}, make_ctx())
    assert src.kind == "fake" and src.label == "My fake"
    assert src.info() == {"kind": "fake", "label": "My fake", "status": "waiting", "detail": "", "stats": {}}
    assert create_source({"type": "fake"}, make_ctx()).label == "Fake"
    assert "fake" in source_mod.registered_sources()


def test_create_source_errors(fake_modules):
    with pytest.raises(UnknownSourceError, match="known types"):
        create_source({"type": "warp_drive"}, make_ctx())
    with pytest.raises(MissingDependencyError, match="requirements-hw.txt"):
        create_source({"type": "needs_hw"}, make_ctx())
    with pytest.raises(SourceError, match="did not register"):
        create_source({"type": "unregistered"}, make_ctx())
    with pytest.raises(SourceError, match="cannot load"):
        create_source({"type": "broken"}, make_ctx())


def test_import_hardware_helper():
    assert import_hardware("math") is math
    with pytest.raises(MissingDependencyError, match="pip install -r requirements-hw.txt"):
        import_hardware("serial.this_submodule_does_not_exist")


def test_register_source_requires_source_subclass():
    with pytest.raises(TypeError):
        register_source("x")(object)


def test_source_modules_map_matches_spec():
    assert source_mod.SOURCE_MODULES == {
        "sim": "aerovolt.sim.source",
        "serial": "aerovolt.sources.serial_source",
        "can": "aerovolt.sources.can_source",
        "replay": "aerovolt.sources.replay_source",
    }


def test_session_clock():
    now = [10.0]
    clock = SessionClock(lambda: now[0])
    now[0] = 12.5
    assert clock() == 2.5
    clock.reset()
    assert clock() == 0.0
