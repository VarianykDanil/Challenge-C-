"""Real-sensor paths, end to end through the whole stack (Session, SourceManager, store,
Processor, web server):

* **HYBRID** - the Phase-2 bench demo: the simulator plus ``tools/fake_sensor_node.py --pty``
  (a separate process, exactly as a student would run it). The node's ``fw_p03`` overrides
  the simulated tap - in the store, in the WebSocket frames (owner ``serial``) and in the
  measured rates - and when the node stops the simulated value returns about 1 s later.
* **CAN** - a car on the bus: every raw channel of one simulator sample is encoded with the
  DBC (``CanMap.encode_all``) and broadcast on python-can's virtual bus; the session's
  ``CanSource`` decodes all 298 channels into the store within one CAN resolution step and
  the analysis computes from them (mode ``LIVE``).
* **REPLAY** - a logged simulator run with a fault is replayed through the analysis, which
  recomputes the same lap and raises the same alert.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import math
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path

import aiohttp
import pytest
import yaml

pytest.importorskip("aerovolt.sim.source")
pytest.importorskip("aerovolt.analysis.processor")

from aerovolt.core import physics  # noqa: E402
from aerovolt.core.config import PROJECT_ROOT, load_config  # noqa: E402
from aerovolt.server.app import start_server  # noqa: E402
from aerovolt.server.session import Session  # noqa: E402

FAKE_NODE = PROJECT_ROOT / "tools" / "fake_sensor_node.py"


def load_fake_node():
    spec = importlib.util.spec_from_file_location("fake_sensor_node_e2e", FAKE_NODE)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


async def next_message(ws: aiohttp.ClientWebSocketResponse, kind: str, timeout: float = 5.0) -> dict:
    """The next WebSocket message of the given type."""
    deadline = time.monotonic() + timeout
    while True:
        msg = json.loads((await asyncio.wait_for(ws.receive(), max(0.1, deadline - time.monotonic()))).data)
        if msg["type"] == kind:
            return msg


# ---------------------------------------------------------------------------------- HYBRID


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="pseudo-terminal needs Linux")
def test_hybrid_fake_node_overrides_sim_tap_through_the_web_server(tmp_path: Path) -> None:
    pytest.importorskip("serial")
    fake = load_fake_node()
    bench_cfg = tmp_path / "bench.yaml"
    node = subprocess.Popen(
        [sys.executable, str(FAKE_NODE), "--pty", "--pattern", "steady", "--speed", "20", "--noise", "0",
         "--channels", "fw_p03", "--config-out", str(bench_cfg)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        port_path = node.stdout.readline().split(" on ")[1].split()[0]
        for _ in range(100):  # the config is written right after the path is printed
            if bench_cfg.exists():
                break
            time.sleep(0.05)
        config = load_config(bench_cfg)
        assert [s["type"] for s in config.sources] == ["sim", "serial"]
        assert config.sources[1]["port"] == port_path
        session = Session(config)
        q = 0.5 * float(physics.moist_air_density(18.0, 101325.0, 60.0)) * 20.0 ** 2
        expected = fake.tap_cp(config.catalog["fw_p03"]) * q

        async def main() -> None:
            runner, port = await start_server(session, "127.0.0.1", 0)
            try:
                async with aiohttp.ClientSession() as http:
                    async with http.ws_connect(f"http://127.0.0.1:{port}/ws") as ws:
                        hello = await next_message(ws, "hello")
                        assert [s["kind"] for s in hello["sources"]] == ["sim", "serial"]
                        # 1) the node's value wins: owner 'serial' in the frames
                        frame = None
                        deadline = time.monotonic() + 15
                        while time.monotonic() < deadline:
                            msg = await next_message(ws, "frame")
                            if msg["owner"].get("fw_p03") == "serial":
                                frame = msg
                                break
                        assert frame is not None, "the serial node never took over fw_p03"
                        assert session.mode == "HYBRID"
                        assert frame["v"]["fw_p03"] == pytest.approx(expected, abs=0.2)
                        assert "fw_p01" not in frame["owner"]  # the other taps stay simulated
                        # 2) the sources message reports the node and the measured rates
                        await asyncio.sleep(1.2)
                        sources = await next_message(ws, "sources")
                        serial_info = sources["sources"][1]
                        assert serial_info["status"] == "running" and serial_info["stats"]["node"] == "FAKE"
                        assert 30.0 <= sources["rates"]["fw_p03"] <= 70.0  # node sends 50 lines/s
                        assert 90.0 <= sources["rates"]["ax"] <= 110.0  # simulated IMU: 100 Hz
                        # 3) the node stops: the simulated tap comes back after the 1 s window
                        node.send_signal(signal.SIGINT)
                        node.wait(timeout=10)
                        t_stop = time.monotonic()
                        back = None
                        while time.monotonic() - t_stop < 5:
                            msg = await next_message(ws, "frame")
                            if "fw_p03" not in msg["owner"]:
                                back = time.monotonic() - t_stop
                                break
                        assert back is not None and 0.5 <= back <= 2.5
                        assert session.manager.owner("fw_p03") == "sim"
                        assert session.store.latest("fw_p03") != pytest.approx(expected, abs=0.2)
            finally:
                await runner.cleanup()

        asyncio.run(main())
    finally:
        if node.poll() is None:
            node.kill()
        node.wait(timeout=10)
        node.stdout.close()
        node.stderr.close()


# ------------------------------------------------------------------------------------- CAN


def test_can_bus_every_raw_channel_decodes_into_the_store(tmp_path: Path) -> None:
    can = pytest.importorskip("can")
    pytest.importorskip("cantools")
    from aerovolt.core.canutil import load_can_layout
    from aerovolt.sim.engine import SimEngine
    from aerovolt.sources.canmap import CanMap

    channel = f"e2e_{uuid.uuid4().hex[:8]}"
    cfg_path = tmp_path / "car.yaml"
    cfg_path.write_text(yaml.safe_dump({
        "session": {"name": "e2e CAN"}, "track": "fs_endurance",
        "sources": [{"type": "can", "label": "Car CAN", "interface": "virtual", "channel": channel}],
    }), encoding="utf-8")
    config = load_config(cfg_path)
    session = Session(config)

    # One complete state of the car (every raw channel), as the car's ECUs would send it.
    engine = SimEngine(config.vehicle, config.catalog, seed=5)
    for _ in range(1500):  # 15 s: driving, everything warmed up a little
        engine.step()
    truth = {cid: v for cid, v in engine.sample_all().items() if cid in set(config.catalog.raw_ids())}
    cmap = CanMap.from_dbc(PROJECT_ROOT / "can" / "aerovolt.dbc")
    frames = cmap.encode_all(truth)
    layout = load_can_layout(PROJECT_ROOT / "config" / "can_layout.yaml")

    async def main() -> None:
        bus = can.Bus(interface="virtual", channel=channel)
        await session.start()
        try:
            for _ in range(100):
                if session.sources[0].status == "running":
                    break
                await asyncio.sleep(0.02)
            for _ in range(25):  # 0.5 s of the car broadcasting at 50 Hz
                for frame_id, data in frames:
                    bus.send(can.Message(arbitration_id=frame_id, data=data, is_extended_id=False))
                await asyncio.sleep(0.02)
            await asyncio.sleep(1.2)  # the 1 Hz wall-clock fallback runs the analysis
        finally:
            await session.stop()
            bus.shutdown()

    asyncio.run(main())

    assert session.mode == "LIVE"
    stats = session.sources_info()[0]["stats"]
    assert stats["decode_errors"] == 0 and stats["unknown_ids"] == 0 and stats["frames"] >= 25 * len(frames)
    wrong = []
    for cid, value in truth.items():
        _, sig = layout.by_signal[cid]
        got = session.store.latest(cid)
        if not math.isfinite(value):
            continue
        clipped = min(max(value, sig.phys_min), sig.phys_max)
        if not abs(got - clipped) <= sig.scale / 2 + 1e-6:
            wrong.append((cid, value, got))
        assert session.manager.owner(cid) == "can"
    assert not wrong, f"decoded values off by more than one CAN step: {wrong[:5]}"
    # the analysis ran on the decoded data
    assert session.store.latest("calc_q") == pytest.approx(truth["pitot_dp"], abs=0.5)
    assert session.store.latest("calc_cell_v_min") == pytest.approx(
        min(truth[f"cell_v_{k:03d}"] for k in range(140)), abs=0.001)


# ---------------------------------------------------------------------------------- REPLAY


def test_replay_of_a_logged_run_recomputes_laps_and_alerts(tmp_path: Path) -> None:
    log_path = tmp_path / "run.csv.gz"
    duration = 75.0  # lap 1 ends at ~63 s
    config = load_config(PROJECT_ROOT / "config" / "demo.yaml",
                         {"speed": "max", "faults": ["pitot_blocked@40"], "log": str(log_path), "duration": duration})
    original = asyncio.run(Session(config).run_headless(duration))
    assert len(original["laps"]) == 1
    assert "sensor_pitot_implausible" in {a["id"] for a in original["alerts"]}

    replay_cfg = tmp_path / "replay.yaml"
    replay_cfg.write_text(yaml.safe_dump({
        "session": {"name": "e2e replay"},
        "sources": [{"type": "replay", "label": "Replay", "file": str(log_path), "speed": "max"}],
    }), encoding="utf-8")
    replay = asyncio.run(asyncio.wait_for(Session(load_config(replay_cfg)).run_headless(), 120))

    assert replay["mode"] == "REPLAY" and replay["track"] == "fs_endurance"
    assert replay["stats"]["processor_errors"] == 0
    assert [lap["lap"] for lap in replay["laps"]] == [1]
    assert replay["laps"][0]["lap_time"] == pytest.approx(original["laps"][0]["lap_time"], abs=0.15)
    raised = {a["id"]: a["t_start"] for a in replay["alerts"]}
    assert set(raised) == {a["id"] for a in original["alerts"]}
    assert 40.0 <= raised["sensor_pitot_implausible"] <= 55.0
    assert replay["final"]["calc_soc_ekf"] == pytest.approx(original["final"]["calc_soc_ekf"], abs=0.5)
