"""End to end with the REAL simulator and analysis: headless run + log + replay, the web
server, the CLI, and the hybrid bench demo (simulator + a USB-serial node on a pty)."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import aiohttp
import pytest
import yaml

pytest.importorskip("aerovolt.sim.source")
pytest.importorskip("aerovolt.analysis.processor")

from aerovolt.core.config import PROJECT_ROOT, load_config  # noqa: E402
from aerovolt.datalog.reader import read_log  # noqa: E402
from aerovolt.server.app import start_server  # noqa: E402
from aerovolt.server.session import Session  # noqa: E402


def write_cfg(tmp_path: Path, sources: list[dict], name: str = "cfg.yaml", **extra) -> Path:
    path = tmp_path / name
    data = {"session": {"name": "integration"}, "track": "fs_endurance", "sources": sources, **extra}
    path.write_text(yaml.safe_dump(data), encoding="utf-8")
    return path


SIM_MAX = {"type": "sim", "speed": "max", "seed": 7}


def test_headless_real_sim_logs_then_replays(tmp_path):
    log_path = tmp_path / "run.csv.gz"
    config = load_config(write_cfg(tmp_path, [SIM_MAX], session={"name": "e2e", "log": str(log_path)}),
                         {"faults": ["pitot_blocked@1"]})
    session = Session(config)
    assert session.track is not None and session.track.name == "fs_endurance"
    t0 = time.perf_counter()
    summary = asyncio.run(session.run_headless(duration=5.0))
    wall = time.perf_counter() - t0
    assert summary["duration_s"] == 5.0 and summary["mode"] == "SIM"
    assert wall < 5.0  # faster than real time (target >= 10x on one core)
    final = summary["final"]
    assert final["calc_soc_ekf"] is not None and 90 < final["calc_soc_ekf"] <= 100.5
    assert final["pack_voltage"] is not None
    assert summary["faults"] == [{"t": 1.0, "id": "pitot_blocked", "active": True, "by": "sim"}]
    assert summary["stats"]["processor_errors"] == 0
    assert summary["stats"]["ticks"] == 101  # 20 Hz of data time over 5 s, plus t = 0

    log = read_log(log_path)
    assert len(log) == 101 and log.t[-1] == pytest.approx(5.0)
    assert log.meta["track"]["name"] == "fs_endurance" and log.meta["faults"][0]["id"] == "pitot_blocked"
    assert set(config.catalog.raw_ids()) <= set(log.ids)

    # Replay the log through the full pipeline (calc_* recomputed from the raw channels).
    replay_cfg = load_config(write_cfg(tmp_path, [{"type": "replay", "file": str(log_path), "speed": "max"}],
                                       name="replay.yaml"))
    replay = Session(replay_cfg)
    assert replay.track is not None and replay.track.name == "fs_endurance"  # from the sidecar
    rsum = asyncio.run(asyncio.wait_for(replay.run_headless(), 30))
    assert rsum["mode"] == "REPLAY" and rsum["duration_s"] == pytest.approx(5.0)
    assert rsum["final"]["calc_soc_ekf"] is not None
    assert rsum["stats"]["processor_errors"] == 0


def test_server_with_real_sim(tmp_path):
    session = Session(load_config(write_cfg(tmp_path, [SIM_MAX])))

    async def main():
        runner, port = await start_server(session, "127.0.0.1", 0)
        try:
            async with aiohttp.ClientSession() as http:
                async with http.ws_connect(f"http://127.0.0.1:{port}/ws") as ws:
                    hello = json.loads((await ws.receive()).data)
                    assert hello["mode"] == "SIM" and hello["track"]["name"] == "fs_endurance"
                    assert len(hello["faults"]) == 12 and len(hello["channels"]) == len(session.catalog)
                    frame = None
                    deadline = time.monotonic() + 10
                    while time.monotonic() < deadline:
                        msg = json.loads((await asyncio.wait_for(ws.receive(), 5)).data)
                        if msg["type"] == "frame" and msg["t"] > 2.0:
                            frame = msg
                            break
                    assert frame is not None
                    v = frame["v"]
                    assert v["truth_speed"] is not None and v["calc_rho"] is not None
                    assert v["cell_v_139"] is not None and "calc_soc_ekf" in v
                async with http.post(f"http://127.0.0.1:{port}/api/faults/cell_hot", json={"active": True}) as r:
                    assert r.status == 200
                    assert next(f for f in await r.json() if f["id"] == "cell_hot")["active"] is True
                async with http.get(f"http://127.0.0.1:{port}/api/history?ids=calc_q,pitot_dp&seconds=5") as r:
                    hist = await r.json()
                    assert len(hist["t"]) > 10
        finally:
            await runner.cleanup()

    asyncio.run(main())
    assert session.fault_timeline[-1]["id"] == "cell_hot" and session.fault_timeline[-1]["by"] == "user"


def test_cli_headless_subprocess(tmp_path):
    cfg = write_cfg(tmp_path, [{"type": "sim", "seed": 3}])
    proc = subprocess.run(
        [sys.executable, "-m", "aerovolt", "--config", str(cfg), "--headless", "--duration", "4",
         "--speed", "max", "--fault", "cell_hot@1"],
        cwd=PROJECT_ROOT, capture_output=True, text=True, timeout=120)
    assert proc.returncode == 0, proc.stderr
    out = proc.stdout
    assert "AeroVolt headless run - mode SIM, track fs_endurance" in out
    assert "session time 4.0 s" in out
    assert "Fault timeline" in out and "cell_hot" in out
    assert "calc_soc_ekf" in out


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="pseudo-terminal needs Linux")
def test_hybrid_bench_demo_serial_node_overrides_sim_tap(tmp_path):
    """Phase-2 bench demo: the simulator provides everything, a real node (here a pty)
    provides fw_p03; when the node stops, the simulated value returns after ~1 s."""
    pytest.importorskip("serial")
    import tty

    from aerovolt.sources.protocol import format_data, format_hello

    master, slave = os.openpty()
    tty.setraw(slave)
    port = os.ttyname(slave)
    config = load_config(write_cfg(tmp_path, [
        {"type": "sim", "speed": 1.0, "seed": 1},
        {"type": "serial", "port": port, "channels": ["fw_p03"], "label": "Bench node"},
    ]))
    session = Session(config)
    assert session.data_driven

    async def main():
        await session.start()
        try:
            serial_src = session.sources[1]
            for _ in range(300):
                if serial_src.status == "running":
                    break
                await asyncio.sleep(0.01)
            os.write(master, format_hello("BENCH1", "1.0.0", ["fw_p03"]).encode())
            for i in range(40):  # 50 Hz for 0.8 s
                os.write(master, format_data("BENCH1", i * 20, {"fw_p03": -1234.5, "fw_p04": 99.0}).encode())
                await asyncio.sleep(0.02)
            assert session.manager.owner("fw_p03") == "serial"
            assert session.store.latest("fw_p03") == -1234.5
            assert session.manager.owner("fw_p04") == "sim"
            frame = session.frame()
            assert frame["owner"] == {"fw_p03": "serial"} and frame["v"]["fw_p03"] == -1234.5
            assert session.mode == "HYBRID"
            # serial samples are stamped on the simulator's time line
            assert abs(session.store.timestamp("fw_p03") - session.t) < 0.2
            info = session.sources_info()[1]
            assert info["stats"]["node"] == "BENCH1" and info["stats"]["fw_version"] == "1.0.0"
            await asyncio.sleep(1.3)  # node silent: the simulated tap comes back
            assert session.manager.owner("fw_p03") == "sim"
            assert session.store.latest("fw_p03") != -1234.5
        finally:
            await session.stop()

    try:
        asyncio.run(main())
    finally:
        os.close(master)
        os.close(slave)
