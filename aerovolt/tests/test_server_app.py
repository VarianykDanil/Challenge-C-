"""Web server (SPEC 9): WebSocket hello/frames/events, REST API, static files, shutdown.

Each test starts the real aiohttp server on an ephemeral port (port 0) with a stub source
and a stub processor, and talks to it with aiohttp's client.
"""

from __future__ import annotations

import asyncio
import json
import socket
from pathlib import Path
from typing import Any

import aiohttp
import pytest
import yaml

from aerovolt.core.config import load_config
from aerovolt.core.model import Alert, FaultInfo
from aerovolt.core.source import Source
from aerovolt.server.app import PortInUseError, dumps, start_server
from aerovolt.server.session import Session


class PacedSource(Source):
    """Emits ``fw_p03`` every 10 ms (data time = ``i * 0.01`` for a sim, else the clock)."""

    def __init__(self, cfg: dict[str, Any], ctx: Any) -> None:
        super().__init__(cfg, ctx)
        self.kind = cfg.get("as_kind", "can")
        self.active = {"cell_hot": False}

    async def run(self, emit):
        self.status = "running"
        i = 0
        while True:
            t = i * 0.01 if self.kind == "sim" else self.ctx.clock()
            emit(t, {"fw_p03": -400.0 - i, "pitot_dp": float("nan")})
            i += 1
            await asyncio.sleep(0.01)

    def faults(self):
        if self.kind != "sim":
            return []
        return [FaultInfo(fid, "Hot cell", "powertrain", "bad weld", on) for fid, on in self.active.items()]

    def set_fault(self, fault_id, active):
        if self.kind != "sim":
            raise NotImplementedError
        if fault_id not in self.active:
            raise KeyError(fault_id)
        self.active[fault_id] = active


class AlertingProcessor:
    """Raises one alert at t >= 0.2 s (sim time)."""

    def __init__(self, ctx, store):
        self.store = store
        self.sent = False

    def tick(self, t):
        self.store.update(t, {"calc_q": float("nan")})
        if t >= 0.2 and not self.sent:
            self.sent = True
            alert = Alert("aero_high_yaw", "aero_high_yaw", "warn", "High yaw", "yaw 12°", ["probe_yaw"], t)
            return [{"type": "alert", "alert": alert.to_json()}]
        return []


def make_session(tmp_path: Path, kind: str) -> Session:
    path = tmp_path / "cfg.yaml"
    path.write_text(yaml.safe_dump({"session": {"name": "app test"}, "server": {"broadcast_hz": 20},
                                    "sources": [{"type": "stub", "as_kind": kind}]}))
    return Session(load_config(path), processor_factory=AlertingProcessor,
                   source_factory=lambda cfg, ctx: PacedSource(cfg, ctx))


@pytest.fixture
def web_root(tmp_path: Path) -> Path:
    root = tmp_path / "web"
    (root / "js").mkdir(parents=True)
    (root / "index.html").write_text("<!doctype html><title>AeroVolt</title>", encoding="utf-8")
    (root / "js" / "main.js").write_text("export const x = 1;\n", encoding="utf-8")
    (tmp_path / "secret.txt").write_text("not for the web")
    return root


async def receive(ws: aiohttp.ClientWebSocketResponse, kind: str, timeout: float = 3.0) -> dict:
    """Next message of type ``kind`` (others are skipped)."""
    async def loop():
        while True:
            msg = json.loads((await ws.receive()).data)
            if msg["type"] == kind:
                return msg
    return await asyncio.wait_for(loop(), timeout)


def test_websocket_hello_frames_events_and_sources(tmp_path, web_root):
    session = make_session(tmp_path, "sim")

    async def main():
        runner, port = await start_server(session, "127.0.0.1", 0, web_root)
        try:
            async with aiohttp.ClientSession() as http:
                async with http.ws_connect(f"http://127.0.0.1:{port}/ws") as ws:
                    hello = json.loads((await ws.receive()).data)  # first message
                    assert hello["type"] == "hello" and hello["version"] == "1.0" and hello["mode"] == "SIM"
                    assert hello["session"]["name"] == "app test"
                    assert {"sources", "channels", "track", "vehicle", "faults", "alerts", "laps",
                            "strategy", "t"} <= set(hello)
                    assert hello["faults"] == [{"id": "cell_hot", "title": "Hot cell", "system": "powertrain",
                                                "description": "bad weld", "active": False, "alerts": []}]
                    frames = [await receive(ws, "frame") for _ in range(3)]
                    assert all(isinstance(f["v"]["fw_p03"], float) for f in frames)
                    assert frames[-1]["v"]["pitot_dp"] is None  # NaN -> null
                    assert frames[-1]["owner"] == {}
                    assert frames[-1]["t"] >= frames[0]["t"]
                    alert = await receive(ws, "alert")
                    assert alert["alert"]["id"] == "aero_high_yaw" and alert["alert"]["active"] is True
                    sources = await receive(ws, "sources", timeout=3.0)
                    assert sources["sources"][0]["kind"] == "sim"
                    # fault injection is broadcast as a 'faults' event
                    async with http.post(f"http://127.0.0.1:{port}/api/faults/cell_hot",
                                         json={"active": True}) as resp:
                        assert resp.status == 200
                        assert (await resp.json())[0]["active"] is True
                    event = await receive(ws, "faults")
                    assert event["faults"][0]["active"] is True
                    # reset: every client gets a fresh hello
                    async with http.post(f"http://127.0.0.1:{port}/api/session/reset") as resp:
                        assert resp.status == 200 and await resp.json() == {"ok": True}
                    hello2 = await receive(ws, "hello")
                    assert hello2["alerts"] == [] and hello2["faults"][0]["active"] is False
        finally:
            await runner.cleanup()
        assert not session.running  # graceful shutdown stopped the sources

    asyncio.run(main())


def test_rest_api_without_sim(tmp_path, web_root):
    session = make_session(tmp_path, "can")

    async def main():
        runner, port = await start_server(session, "127.0.0.1", 0, web_root)
        base = f"http://127.0.0.1:{port}"
        try:
            async with aiohttp.ClientSession() as http:
                await asyncio.sleep(0.3)
                async with http.get(f"{base}/api/hello") as r:
                    hello = await r.json()
                    assert r.status == 200 and hello["mode"] == "LIVE" and hello["faults"] == []
                    assert "no-cache" in r.headers["Cache-Control"]
                async with http.get(f"{base}/api/history?ids=fw_p03,pitot_dp&seconds=60") as r:
                    hist = await r.json()
                    assert len(hist["t"]) >= 2 and len(hist["series"]["fw_p03"]) == len(hist["t"])
                    assert all(v is None for v in hist["series"]["pitot_dp"])
                for query in ("", "?ids=fw_p03&seconds=abc", "?ids=fw_p03&seconds=-1"):
                    async with http.get(f"{base}/api/history{query}") as r:
                        assert r.status == 400
                async with http.get(f"{base}/api/faults") as r:
                    assert await r.json() == []
                async with http.post(f"{base}/api/faults/cell_hot", json={"active": True}) as r:
                    assert r.status == 409 and "simulator" in (await r.json())["error"]
                async with http.get(f"{base}/api/laps") as r:
                    assert await r.json() == []
                async with http.get(f"{base}/api/alerts") as r:
                    assert [a["id"] for a in await r.json()] == ["aero_high_yaw"]  # raised at t >= 0.2 s
                async with http.get(f"{base}/api/sources") as r:
                    sources = await r.json()
                    assert sources[0]["kind"] == "can" and sources[0]["status"] == "running"
        finally:
            await runner.cleanup()

    asyncio.run(main())


def test_fault_request_validation(tmp_path, web_root):
    session = make_session(tmp_path, "sim")

    async def main():
        runner, port = await start_server(session, "127.0.0.1", 0, web_root)
        base = f"http://127.0.0.1:{port}"
        try:
            async with aiohttp.ClientSession() as http:
                for body in ("not json", json.dumps({"on": True}), json.dumps({"active": "yes"})):
                    async with http.post(f"{base}/api/faults/cell_hot", data=body) as r:
                        assert r.status == 400
                async with http.post(f"{base}/api/faults/no_such_fault", json={"active": True}) as r:
                    assert r.status == 404
                async with http.get(f"{base}/api/faults") as r:
                    assert (await r.json())[0]["active"] is False
        finally:
            await runner.cleanup()

    asyncio.run(main())


def test_static_files_mime_types_and_safety(tmp_path, web_root):
    session = make_session(tmp_path, "can")

    async def main():
        runner, port = await start_server(session, "127.0.0.1", 0, web_root)
        base = f"http://127.0.0.1:{port}"
        try:
            async with aiohttp.ClientSession() as http:
                async with http.get(f"{base}/") as r:
                    assert r.status == 200 and "AeroVolt" in await r.text()
                    assert r.headers["Content-Type"].startswith("text/html")
                    assert "no-store" in r.headers["Cache-Control"]
                async with http.get(f"{base}/js/main.js") as r:
                    assert r.status == 200 and r.headers["Content-Type"].startswith("text/javascript")
                async with http.get(f"{base}/js/missing.js") as r:
                    assert r.status == 404
                async with http.get(f"{base}/%2e%2e/secret.txt") as r:
                    assert r.status in (403, 404)
        finally:
            await runner.cleanup()
        # Without a dashboard folder a helpful placeholder page is served.
        empty = tmp_path / "empty_web"
        empty.mkdir()
        runner, port = await start_server(make_session(tmp_path, "can"), "127.0.0.1", 0, empty)
        try:
            async with aiohttp.ClientSession() as http:
                async with http.get(f"http://127.0.0.1:{port}/") as r:
                    assert r.status == 200 and "/api/hello" in await r.text()
        finally:
            await runner.cleanup()

    asyncio.run(main())


def test_port_in_use_is_reported(tmp_path, web_root):
    blocker = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    blocker.bind(("127.0.0.1", 0))
    blocker.listen(1)
    port = blocker.getsockname()[1]
    session = make_session(tmp_path, "can")
    try:
        with pytest.raises(PortInUseError):
            asyncio.run(start_server(session, "127.0.0.1", port, web_root))
    finally:
        blocker.close()
    assert not session.running


def test_dumps_never_emits_nan():
    text = dumps({"a": float("nan"), "b": [1.0, float("inf")], "c": "x"})
    assert json.loads(text) == {"a": None, "b": [1.0, None], "c": "x"}
