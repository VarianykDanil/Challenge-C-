"""SerialSource end to end over a pseudo-terminal (no hardware needed).

``os.openpty()`` creates a master/slave pair: the test writes the node's output to the
master, and the source opens the slave device path (``/dev/pts/N``) with pyserial exactly
as it would open ``/dev/ttyACM0``.
"""

from __future__ import annotations

import asyncio
import math
import os
import sys
import time
import tty
from pathlib import Path
from typing import Any, Callable

import pytest

pytest.importorskip("serial")
if not sys.platform.startswith("linux"):
    pytest.skip("pseudo-terminal tests need Linux", allow_module_level=True)

from aerovolt.core.config import load_config  # noqa: E402
from aerovolt.core.manager import SourceManager  # noqa: E402
from aerovolt.core.source import SessionContext, create_source  # noqa: E402
from aerovolt.sources import serial_source  # noqa: E402
from aerovolt.sources.protocol import format_data, format_hello, format_status, with_checksum  # noqa: E402


class Pty:
    """A fake serial device: write node output to ``master``; ``path`` is the device."""

    def __init__(self) -> None:
        self.master, self.slave = os.openpty()
        tty.setraw(self.slave)  # no echo / CR-LF translation before pyserial configures it
        self.path = os.ttyname(self.slave)

    def write(self, text: str) -> None:
        os.write(self.master, text.encode("ascii"))

    def close(self) -> None:
        for fd in (self.master, self.slave):
            try:
                os.close(fd)
            except OSError:
                pass


@pytest.fixture(scope="module")
def config():
    return load_config(None)


def make_ctx(config, clock: Callable[[], float] | None = None) -> SessionContext:
    t0 = time.monotonic()
    return SessionContext(config=config, catalog=config.catalog, vehicle=config.vehicle, root=config.root,
                          clock=clock or (lambda: time.monotonic() - t0))


async def wait_until(cond: Callable[[], bool], timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not cond():
        if time.monotonic() > deadline:
            raise AssertionError("condition not reached in time")
        await asyncio.sleep(0.01)


class Collector:
    def __init__(self) -> None:
        self.samples: list[tuple[float, dict[str, float]]] = []

    def __call__(self, t: float, values: dict[str, float]) -> None:
        self.samples.append((t, dict(values)))

    def values(self, cid: str) -> list[float]:
        return [v[cid] for _, v in self.samples if cid in v]


async def run_source(src: Any, emit: Any, body: Callable[[], Any]) -> None:
    task = asyncio.create_task(src.run(emit))
    try:
        await body()
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


def test_end_to_end_lines_values_and_stats(config):
    pty = Pty()
    try:
        ctx = make_ctx(config, clock=lambda: 12.5)
        src = create_source({"type": "serial", "port": pty.path, "baud": 115200, "label": "Bench"}, ctx)
        assert src.kind == "serial"
        out = Collector()

        async def body():
            await wait_until(lambda: src.status == "running")
            pty.write("Booting node...\r\n")                                   # free text: ignored
            pty.write(format_hello("AERO1", "1.4.2", ["fw_p03", "amb_temp"]))
            pty.write(format_data("AERO1", 100, {"fw_p03": -412.5, "amb_temp": 18.4}))
            pty.write(format_data("AERO1", 120, {"fw_p03": -400.5}).replace("-400.5", "-400.6"))  # corrupt
            pty.write(with_checksum("AV,AERO1,abc,fw_p03=1") + "\r\n")        # malformed
            pty.write(format_data("AERO1", 140, {"fw_p03": float("nan"), "no_such_channel": 3.0}))
            pty.write(format_status("AERO1", 150, "warn", "sensor 2 CRC error"))
            pty.write('{"fw_p03": -390.25}\n')                                 # JSON line
            # A line split across two writes must be reassembled.
            line = format_data("AERO1", 160, {"amb_temp": 18.5})
            pty.write(line[:10])
            await asyncio.sleep(0.05)
            pty.write(line[10:])
            await wait_until(lambda: src.stats["lines"] >= 6)

        asyncio.run(run_source(src, out, body))
        assert out.values("fw_p03")[0] == -412.5
        assert math.isnan(out.values("fw_p03")[1])
        assert out.values("fw_p03")[2] == -390.25
        assert out.values("amb_temp") == [18.4, 18.5]
        assert all(t == 12.5 for t, _ in out.samples)  # stamped on arrival with the session clock
        assert all("no_such_channel" not in v for _, v in out.samples)
        s = src.stats
        assert s["checksum_errors"] == 1
        assert s["malformed"] == 1
        assert s["unknown_channels"] == 1
        assert s["node"] == "AERO1" and s["fw_version"] == "1.4.2" and s["last_hello"] == 12.5
        assert s["last_status"]["status"] == "warn"
        assert s["samples"] == 5 and s["lines"] == 6 and s["port"] == pty.path
        assert src.announced == ["fw_p03", "amb_temp"]
        info = src.info()
        assert info["kind"] == "serial" and info["label"] == "Bench" and "AERO1" in info["detail"]
    finally:
        pty.close()


def test_rate_statistic(config):
    pty = Pty()
    try:
        src = create_source({"type": "serial", "port": pty.path}, make_ctx(config))
        out = Collector()

        async def body():
            await wait_until(lambda: src.status == "running")
            for i in range(30):
                pty.write(format_data("N", i * 20, {"fw_p03": float(i)}))
                await asyncio.sleep(0.02)
            await wait_until(lambda: src.stats["lines"] >= 30)

        asyncio.run(run_source(src, out, body))
        assert 15 < src.stats["rate_hz"] < 80  # ~50 lines/s, generous for a busy CI machine
        assert out.values("fw_p03") == [float(i) for i in range(30)]
    finally:
        pty.close()


def test_unplug_then_reconnect(config, tmp_path: Path):
    """The port is a symlink (like /dev/serial/by-id/...): unplug = pty closed, replug =
    the link points to a new pty. The source must report 'waiting' and then recover."""
    first, second = Pty(), Pty()
    link = tmp_path / "ttyACM-node"
    link.symlink_to(first.path)
    try:
        src = create_source({"type": "serial", "port": str(link), "reconnect_s": 0.1}, make_ctx(config))
        out = Collector()

        async def body():
            await wait_until(lambda: src.status == "running")
            first.write(format_data("N", 1, {"fw_p03": 1.0}))
            await wait_until(lambda: out.values("fw_p03") == [1.0])
            first.close()  # cable pulled
            await wait_until(lambda: src.status == "waiting")
            assert "disconnected" in src.detail or "not found" in src.detail
            link.unlink()
            link.symlink_to(second.path)  # plugged back in
            await wait_until(lambda: src.status == "running" and src.stats["connects"] >= 2)
            second.write(format_data("N", 2, {"fw_p03": 2.0}))
            await wait_until(lambda: out.values("fw_p03") == [1.0, 2.0])

        asyncio.run(run_source(src, out, body))
    finally:
        first.close()
        second.close()


def test_missing_port_waits_with_a_helpful_message(config, monkeypatch):
    monkeypatch.setattr(serial_source, "list_candidate_ports", lambda: ["/dev/ttyUSB7"])
    src = create_source({"type": "serial", "port": "/dev/aerovolt-no-such-port", "reconnect_s": 0.05},
                        make_ctx(config))

    async def body():
        await wait_until(lambda: "not found" in src.detail)
        await asyncio.sleep(0.15)  # several retries, no exception

    asyncio.run(run_source(src, Collector(), body))
    assert src.status == "waiting"
    assert "/dev/aerovolt-no-such-port" in src.detail and "/dev/ttyUSB7" in src.detail


def test_auto_port_picks_the_device_that_speaks_aerovolt(config, monkeypatch):
    silent, node = Pty(), Pty()
    try:
        monkeypatch.setattr(serial_source, "list_candidate_ports", lambda: [silent.path, node.path])
        src = create_source({"type": "serial", "port": "auto", "probe_s": 0.3, "reconnect_s": 0.05},
                            make_ctx(config))
        out = Collector()

        async def chatter():  # pyserial flushes input on open, so keep talking like a real device
            while True:
                silent.write("random modem noise\r\n")
                node.write(format_hello("AERO1", "1.0", ["fw_p03"]))
                await asyncio.sleep(0.05)

        async def body():
            talker = asyncio.create_task(chatter())
            await wait_until(lambda: src.status == "running")
            talker.cancel()
            assert src.port == node.path
            node.write(format_data("AERO1", 5, {"fw_p03": -5.5}))
            await wait_until(lambda: out.values("fw_p03") == [-5.5])

        asyncio.run(run_source(src, out, body))
    finally:
        silent.close()
        node.close()


def test_auto_port_falls_back_to_first_ttyacm(config, monkeypatch):
    monkeypatch.setattr(serial_source, "list_candidate_ports", lambda: ["/dev/ttyS0", "/dev/ttyACM9"])
    monkeypatch.setattr(serial_source, "probe_port", lambda *a, **k: False)
    import serial

    assert serial_source.find_node_port(serial, 115200, 0.01) == "/dev/ttyACM9"
    monkeypatch.setattr(serial_source, "list_candidate_ports", lambda: ["/dev/ttyS0"])
    assert serial_source.find_node_port(serial, 115200, 0.01) is None


def test_serial_value_overrides_the_sim_through_the_manager(config):
    """Hybrid merge with a real serial source: the node's fw_p03 wins, its other channels
    are dropped (``channels: [fw_p03]``) and calibration is applied to it."""
    from aerovolt.core.config import Calibration
    from aerovolt.core.source import Source

    class FakeSim(Source):
        kind = "sim"

        async def run(self, emit):
            while True:
                emit(0.0, {"fw_p03": -100.0, "fw_p04": -90.0})
                await asyncio.sleep(0.01)

    pty = Pty()
    try:
        ctx = make_ctx(config)
        serial_src = create_source({"type": "serial", "port": pty.path, "channels": ["fw_p03"]}, ctx)
        manager = SourceManager([FakeSim({}, ctx), serial_src], config.catalog,
                                {"fw_p03": Calibration(offset=10.0, scale=1.0)})
        store: dict[str, float] = {}

        async def main():
            await manager.start(lambda t, v: store.update(v))
            try:
                await wait_until(lambda: serial_src.status == "running")
                await wait_until(lambda: store.get("fw_p03") == -100.0)
                pty.write(format_data("N", 1, {"fw_p03": -400.0, "fw_p04": 1.0}))
                await wait_until(lambda: manager.owner("fw_p03") == "serial")
                await asyncio.sleep(0.1)
                assert store["fw_p03"] == -410.0  # (raw - offset) * scale, sim values dropped
                assert store["fw_p04"] == -90.0  # not in the node's channel list
                assert manager.owner_overrides() == {"fw_p03": "serial"}
                assert manager.mode == "HYBRID"
            finally:
                await manager.stop()

        asyncio.run(main())
    finally:
        pty.close()
