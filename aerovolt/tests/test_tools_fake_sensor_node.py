"""tools/fake_sensor_node.py: patterns, protocol lines, pty / serial / CAN transports.

The end-to-end tests connect the fake node to AeroVolt's real ``SerialSource`` (through a
pseudo-terminal) and ``CanSource`` (python-can's in-process virtual bus), i.e. exactly the
path the Phase-2 bench demo uses.
"""

from __future__ import annotations

import asyncio
import importlib.util
import math
import statistics
import subprocess
import sys
import threading
import uuid
from pathlib import Path

import pytest

from aerovolt.core import physics
from aerovolt.core.catalog import Catalog
from aerovolt.core.config import load_config
from aerovolt.core.source import SessionContext
from aerovolt.sources.protocol import parse_line

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / "tools" / "fake_sensor_node.py"


def _load_tool():
    spec = importlib.util.spec_from_file_location("fake_sensor_node", TOOL)
    module = importlib.util.module_from_spec(spec)
    sys.modules["fake_sensor_node"] = module
    spec.loader.exec_module(module)
    return module


fake = _load_tool()


@pytest.fixture(scope="module")
def catalog() -> Catalog:
    return Catalog.load(ROOT / "config" / "sensors.yaml")


@pytest.fixture(scope="module")
def app():
    return load_config(None)


def run_source(source, seconds: float) -> list[tuple[float, dict[str, float]]]:
    """Run an AeroVolt source for `seconds` and return what it emitted."""
    got: list[tuple[float, dict[str, float]]] = []

    async def main() -> None:
        task = asyncio.create_task(source.run(lambda t, v: got.append((t, dict(v)))))
        await asyncio.sleep(seconds)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    asyncio.run(main())
    return got


def start_node(node, sink=None, can_sender=None) -> tuple[threading.Thread, threading.Event]:
    stop = threading.Event()
    thread = threading.Thread(target=fake.run, args=(node, sink, can_sender),
                              kwargs={"duration": 30.0, "stop": stop}, daemon=True)
    thread.start()
    return thread, stop


# ------------------------------------------------------------------------------------------
# Physics of the patterns
# ------------------------------------------------------------------------------------------


def test_cp_table_matches_spec_ranges(catalog: Catalog) -> None:
    """Fixed Cp per tap inside the SPEC 5.4 calibration ranges."""
    cps = {c.id: fake.tap_cp(c) for c in catalog.taps()}
    assert len(cps) == 32
    fw_suction = [cps[c.id] for c in catalog.taps("fw") if c.meta["surface"] == "suction"]
    rw_suction = [cps[c.id] for c in catalog.taps("rw") if c.meta["surface"] == "suction"]
    pressure = [cps[c.id] for c in catalog.taps() if c.meta["surface"] == "pressure"]
    assert -4.0 <= min(fw_suction) <= -2.5 and -3.5 <= min(rw_suction) <= -2.0
    assert all(0.2 <= cp <= 1.0 for cp in pressure)
    floor = {c.id: cps[c.id] for c in catalog.taps("ut")}
    assert min(floor, key=floor.get) == "ut_p03" and -3.0 <= floor["ut_p03"] <= -1.5  # the throat
    assert fake.tap_cp(catalog["pitot_dp"]) == 1.0


def test_drive_speed_trace_is_plausible() -> None:
    t, v = fake.drive_speed_trace()
    dv = [(b - a) / (tb - ta) for a, b, ta, tb in zip(v, v[1:], t, t[1:])]
    assert max(dv) <= fake.ACCEL_MS2 + 1e-9 and min(dv) >= -fake.BRAKE_MS2 - 1e-9
    assert 9.0 <= min(v) and max(v) <= 27.0
    assert 15.0 < t[-1] < 40.0 and v[0] == pytest.approx(v[-1])  # repeats seamlessly


def test_drive_pattern_is_cp_times_q(catalog: Catalog) -> None:
    channels = ["fw_p01", "fw_p05", "ut_p03", "pitot_dp", "amb_temp", "amb_press", "amb_rh"]
    node = fake.FakeNode(catalog, channels, pattern=fake.Pattern("drive"), noise_pa=0.0, rate_hz=100)
    rho = float(physics.moist_air_density(18.0, 101325.0, 60.0))
    checked = 0
    t = 0.0
    while t < node.pattern.lap_time:
        _, values = node.step(t)
        v_now, v_before = node.pattern.airspeed(t), node.pattern.airspeed(t - 0.3)
        if "pitot_dp" in values and abs(v_now - v_before) < 1e-9 and v_now > 5:  # steady speed for 0.3 s
            q = 0.5 * rho * v_now ** 2
            assert values["pitot_dp"] == pytest.approx(q, rel=1e-3)
            for tap in ("fw_p01", "fw_p05", "ut_p03"):
                assert values[tap] / values["pitot_dp"] == pytest.approx(fake.tap_cp(catalog[tap]), rel=2e-3)
            checked += 1
        t += 0.01
    assert checked > 50


def test_steady_offset_and_noise(catalog: Catalog) -> None:
    node = fake.FakeNode(catalog, ["fw_p03"], pattern=fake.Pattern("steady"), noise_pa=0.2,
                         offsets={"fw_p03": 3.4}, seed=3)
    values = [node.step(i * 0.02)[1]["fw_p03"] for i in range(2000)]
    assert statistics.fmean(values) == pytest.approx(3.4, abs=0.03)
    assert statistics.stdev(values) == pytest.approx(0.2, rel=0.1)


def test_sweep_and_blow_patterns() -> None:
    sweep = fake.Pattern("sweep", vmax=30.0, period=20.0)
    assert sweep.airspeed(0.0) == 0.0 and sweep.airspeed(10.0) == pytest.approx(30.0)
    assert sweep.airspeed(5.0) == pytest.approx(15.0) == pytest.approx(sweep.airspeed(15.0))
    blow = fake.Pattern("blow", blow_pa=300.0)
    assert blow.blow(5.0) == 0.0
    blow.blows.append(5.0)
    assert blow.blow(4.9) == 0.0
    assert blow.blow(5.15) == pytest.approx(300 * (1 - math.exp(-1)), rel=1e-6)  # one time constant
    assert blow.blow(6.1) == pytest.approx(300.0, rel=0.01)
    assert blow.blow(8.0) < 30.0
    auto = fake.Pattern("blow", blow_every=4.0)
    assert auto.blow(4.5) > 200 and auto.blow(7.9) < 10
    with pytest.raises(ValueError):
        fake.Pattern("hurricane")


def test_lines_follow_the_protocol(catalog: Catalog) -> None:
    node = fake.FakeNode(catalog, pattern=fake.Pattern("steady"), node="BENCH", fail_at=6.0, fail_for=2.0)
    parsed = []
    for i in range(551):  # t = 0 ... 11.00 s at 50 Hz
        lines, _ = node.step(i * 0.02)
        parsed += [parse_line(line, raise_errors=True) for line in lines]
    assert parsed[0].kind == "hello" and parsed[0].channels == list(fake.DEFAULT_CHANNELS)
    assert parsed[1].kind == "status" and parsed[1].status == "ok"
    assert sum(p.kind == "hello" for p in parsed) == 3  # 0, 5, 10 s
    data = [p for p in parsed if p.kind == "data"]
    assert sum("fw_p03" in p.values for p in data) == 551       # 50 Hz
    assert sum("amb_press" in p.values for p in data) == 12     # 1 Hz: t = 0, 1, ..., 11 s
    failing = [p for p in data if 6000 <= p.ms < 8000]
    assert failing and all(math.isnan(v) for p in failing for v in p.values.values())
    status = [(p.status, p.ms) for p in parsed if p.kind == "status"]
    assert ("error", 6000) in status and ("ok", 8000) in status
    assert all(p.node == "BENCH" for p in data)


def test_rejects_unknown_and_computed_channels(catalog: Catalog) -> None:
    with pytest.raises(ValueError, match="unknown channel"):
        fake.FakeNode(catalog, ["fw_p99"])
    with pytest.raises(ValueError, match="computed"):
        fake.FakeNode(catalog, ["calc_cla"])
    with pytest.raises(ValueError, match="offset"):
        fake.FakeNode(catalog, ["fw_p03"], offsets={"fw_p04": 1.0})
    node = fake.FakeNode(catalog, ["damper_fl", "gps_speed"], pattern=fake.Pattern("sweep"))
    _, values = node.step(0.0)
    assert set(values) == {"damper_fl", "gps_speed"}


# ------------------------------------------------------------------------------------------
# Transports, end to end with the real AeroVolt sources
# ------------------------------------------------------------------------------------------


def test_pty_feeds_the_serial_source(catalog: Catalog, app) -> None:
    pytest.importorskip("serial")
    from aerovolt.sources.serial_source import SerialSource

    node = fake.FakeNode(catalog, pattern=fake.Pattern("steady"), offsets={"fw_p03": -2.5}, node="BENCH")
    sink = fake.PtySink()
    thread, stop = start_node(node, sink)
    try:
        ctx = SessionContext(config=app, catalog=app.catalog, vehicle=app.vehicle, root=app.root)
        source = SerialSource({"type": "serial", "port": sink.path, "baud": 115200}, ctx)
        got = run_source(source, 1.5)
    finally:
        stop.set()
        thread.join(2)
        sink.close()
    taps = [v["fw_p03"] for _, v in got if "fw_p03" in v]
    assert len(taps) > 25  # ~75 expected at 50 lines/s; margin for a busy machine
    assert statistics.fmean(taps) == pytest.approx(-2.5, abs=0.2)
    assert source.stats["node"] == "BENCH" and source.stats["checksum_errors"] == 0


def test_pty_cli_prints_path_and_ready_config(tmp_path: Path) -> None:
    cfg_out = tmp_path / "bench.yaml"
    proc = subprocess.Popen([sys.executable, str(TOOL), "--pty", "--pattern", "steady", "--duration", "4",
                             "--config-out", str(cfg_out)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        first = proc.stdout.readline()
        command = proc.stdout.readline() + proc.stdout.readline()
    finally:
        proc.wait(timeout=15)
    assert proc.returncode == 0, proc.stderr.read()
    path = first.split(" on ")[1].split()[0]
    assert path.startswith("/dev/")
    assert f"-m aerovolt --config {cfg_out}" in command
    config = load_config(cfg_out)
    serial = [s for s in config.sources if s["type"] == "serial"]
    assert serial and serial[0]["port"] == path and serial[0]["channels"] == list(fake.DEFAULT_CHANNELS)
    assert config.sources[0]["type"] == "sim"  # the simulator still provides everything else


def test_stdout_cli() -> None:
    proc = subprocess.run([sys.executable, str(TOOL), "--stdout", "--duration", "1", "--pattern", "drive",
                           "--channels", "fw_p01,pitot_dp"], capture_output=True, text=True, timeout=20)
    assert proc.returncode == 0, proc.stderr
    parsed = [parse_line(line, raise_errors=True) for line in proc.stdout.splitlines()]
    data = [p for p in parsed if p.kind == "data"]
    assert len(data) >= 25 and all(p.values["fw_p01"] < 0 < p.values["pitot_dp"] for p in data)


def test_bad_cli_arguments() -> None:
    proc = subprocess.run([sys.executable, str(TOOL), "--stdout", "--channels", "nope"],
                          capture_output=True, text=True, timeout=20)
    assert proc.returncode == 2 and "unknown channel" in proc.stderr
    pytest.importorskip("can")
    proc = subprocess.run([sys.executable, str(TOOL), "--can", "vcanXnone", "--duration", "1"],
                          capture_output=True, text=True, timeout=20)
    assert proc.returncode == 1 and "cannot open CAN socketcan:vcanXnone" in proc.stderr


def test_can_frames_feed_the_can_source(catalog: Catalog, app) -> None:
    can = pytest.importorskip("can")
    pytest.importorskip("cantools")
    from aerovolt.sources.can_source import CanSource

    channel = f"fake_{uuid.uuid4().hex[:8]}"
    node = fake.FakeNode(catalog, ["fw_p03", "pitot_dp", "amb_temp", "amb_press", "amb_rh"],
                         pattern=fake.Pattern("steady", speed=20.0), noise_pa=0.0)
    sender = fake.CanSender(node.channel_ids, "virtual", channel,
                            bus=can.Bus(interface="virtual", channel=channel))
    assert [f.name for f in sender.frames] == ["AERO_FW_TAPS_A", "AERO_AIR"]
    thread, stop = start_node(node, can_sender=sender)
    try:
        ctx = SessionContext(config=app, catalog=app.catalog, vehicle=app.vehicle, root=app.root)
        source = CanSource({"type": "can", "interface": "virtual", "channel": channel}, ctx)
        got = run_source(source, 1.2)
    finally:
        stop.set()
        thread.join(2)
        sender.close()
    merged: dict[str, float] = {}
    for _, values in got:
        merged.update(values)
    # Only the node's own signals arrive: fw_p01/02/04 were SNA and are dropped by the decoder.
    assert set(merged) == {"fw_p03", "pitot_dp", "amb_temp", "amb_press", "amb_rh"}
    q = 0.5 * float(physics.moist_air_density(18.0, 101325.0, 60.0)) * 20.0 ** 2
    assert merged["pitot_dp"] == pytest.approx(q, abs=0.06)
    assert merged["fw_p03"] == pytest.approx(fake.tap_cp(catalog["fw_p03"]) * q, abs=0.06)
    assert merged["amb_press"] == pytest.approx(101325, abs=8)  # catalogue noise 2 Pa
    frames = sum(1 for _ in got)
    assert frames >= 40  # two 20 ms frames: ~120 expected; margin for a busy machine


def test_parse_can_spec() -> None:
    assert fake.parse_can_spec("virtual") == ("virtual", "aerovolt")
    assert fake.parse_can_spec("vcan0") == ("socketcan", "vcan0")
    assert fake.parse_can_spec("pcan:PCAN_USBBUS1") == ("pcan", "PCAN_USBBUS1")
