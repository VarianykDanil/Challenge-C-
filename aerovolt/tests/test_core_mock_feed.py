"""Tests for tools/mock_feed_server.py (the dev feed the web dashboard is built against)."""

import asyncio
import importlib.util
import json
import socket
import subprocess
import sys
import time
from pathlib import Path

import aiohttp
import pytest
from aiohttp.test_utils import TestClient, TestServer

from aerovolt.core.catalog import Catalog

ROOT = Path(__file__).resolve().parents[1]


def _load_mock():
    spec = importlib.util.spec_from_file_location("mock_feed_server", ROOT / "tools" / "mock_feed_server.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["mock_feed_server"] = module
    spec.loader.exec_module(module)
    return module


mock = _load_mock()
VEHICLE = mock.FALLBACK_VEHICLE  # SPEC section 3 values


@pytest.fixture(scope="module")
def catalog():
    return Catalog.load(ROOT / "config" / "sensors.yaml", VEHICLE)


def test_track_is_closed_loop_about_1km(catalog):
    track = mock.MockTrack.build(VEHICLE["gps_origin"])
    data = track.to_json()
    assert data["closed"] and 950 <= data["length_m"] <= 1050
    assert len(data["xy"]) <= 1500 and len(data["latlon"]) == len(data["xy"])
    lat, lon = data["latlon"][0]
    assert abs(lat - 52.0786) < 0.01 and abs(lon + 1.0169) < 0.02
    assert {f["kind"] for f in data["features"]} <= {"corner", "straight"}
    car = mock.MockCar(catalog, VEHICLE, hybrid=False)
    assert 45 <= car.lap_time_est <= 75  # ~ one lap event per minute


def test_feed_produces_every_channel_events_and_faults(catalog):
    feed = mock.MockFeed(catalog, VEHICLE)
    events = []
    for k in range(int(70 * mock.TICK_HZ)):
        if k == int(5 * mock.TICK_HZ):
            feed.car.set_fault("fw_damage_left", True)
            feed.car.set_fault("cell_hot", True)
            feed.car.set_fault("pump_fail", True)
        events += feed.tick(1.0 / mock.TICK_HZ)
    frame = feed.frame()
    assert set(frame["v"]) == set(catalog.ids())
    json.dumps(frame, allow_nan=False)
    assert frame["owner"] == {}
    kinds = [e["type"] for e in events]
    assert "lap" in kinds and "strategy" in kinds and "alert" in kinds
    raised = {e["alert"]["id"] for e in events if e["type"] == "alert" and e["alert"]["active"]}
    assert {"aero_fw_asymmetry", "bms_cell_temp_outlier", "cooling_no_flow"} <= raised
    v = feed.last_values
    left = [v[f"fw_p0{k}"] for k in range(1, 5)]
    right = [v[f"fw_p{k:02d}"] for k in range(7, 11)]
    assert sum(left) > 0.6 * sum(right)  # left suction (negative) clearly weaker
    assert v["cell_t_20"] > v["cell_t_10"] + 2.0
    assert v["cool_flow"] == 0.0
    lap = next(e["lap"] for e in events if e["type"] == "lap")
    assert lap["lap"] == 1 and 45 < lap["lap_time"] < 75 and lap["energy_kwh"] > 0.1
    strategy = next(e["strategy"] for e in events if e["type"] == "strategy")
    assert [p["kw"] for p in strategy["curve"]] == list(range(40, 85, 5))
    json.dumps(strategy, allow_nan=False)
    feed.car.set_fault("pump_fail", False)
    clear = []
    for _ in range(int(3 * mock.TICK_HZ)):
        clear += feed.tick(1.0 / mock.TICK_HZ)
    assert any(e["type"] == "alert" and e["alert"]["id"] == "cooling_no_flow" and not e["alert"]["active"]
               for e in clear)


def test_hybrid_owner_and_mode(catalog):
    feed = mock.MockFeed(catalog, VEHICLE, hybrid=True)
    feed.tick(0.05)
    assert feed.frame()["owner"] == {"fw_p03": "serial"}
    hello = feed.hello()
    assert hello["mode"] == "HYBRID" and [s["kind"] for s in hello["sources"]] == ["sim", "serial"]


def test_http_and_websocket_protocol(catalog, tmp_path):
    web_root = tmp_path / "web"
    (web_root / "js").mkdir(parents=True)
    (web_root / "index.html").write_text("<!doctype html><title>t</title>")
    (web_root / "js" / "app.js").write_text("export const x = 1;")

    async def scenario():
        feed = mock.MockFeed(catalog, VEHICLE)
        app = mock.create_app(feed, web_root)
        async with TestClient(TestServer(app)) as client:
            ws = await client.ws_connect("/ws")
            hello = await ws.receive_json(timeout=5)
            frames = []
            while len(frames) < 3:
                msg = await ws.receive_json(timeout=5)
                if msg["type"] == "frame":
                    frames.append(msg)
            resp = await client.post("/api/faults/cell_hot", json={"active": True})
            assert resp.status == 200
            faults = await resp.json()
            got_faults_event = False
            for _ in range(50):
                msg = await ws.receive_json(timeout=5)
                if msg["type"] == "faults":
                    got_faults_event = True
                    break
            bad = await client.post("/api/faults/nope", json={"active": True})
            bad_body = await client.post("/api/faults/cell_hot", data="x")
            hist = await (await client.get("/api/history?ids=fw_p01,cell_v_000&seconds=10")).json()
            static_js = await client.get("/js/app.js")
            index = await client.get("/")
            traversal = await client.get("/%2e%2e/%2e%2e/etc/passwd")
            others = {p: (await client.get(p)).status for p in
                      ("/api/hello", "/api/faults", "/api/laps", "/api/alerts", "/api/sources")}
            reset = await client.post("/api/session/reset")
            await ws.close()
            return (hello, frames, faults, got_faults_event, bad.status, bad_body.status, hist, static_js,
                    await static_js.text(), index.status, traversal.status, others, reset.status)

    (hello, frames, faults, got_faults_event, bad, bad_body, hist, static_js, js_text, index, traversal,
     others, reset) = asyncio.run(scenario())
    assert hello["type"] == "hello" and hello["version"] == "1.0" and hello["mode"] == "SIM"
    assert len(hello["channels"]) == len(catalog)
    assert hello["track"]["closed"] and hello["vehicle"]["name"]
    assert {f["id"] for f in hello["faults"]} >= {"fw_damage_left", "cell_hot", "pump_fail", "imd_fault"}
    assert set(frames[-1]["v"]) == set(catalog.ids())
    assert frames[-1]["t"] > frames[0]["t"]
    assert next(f for f in faults if f["id"] == "cell_hot")["active"] is True
    assert got_faults_event
    assert (bad, bad_body) == (404, 400)
    assert set(hist) == {"t", "series"} and len(hist["series"]["fw_p01"]) == len(hist["t"]) > 0
    assert static_js.headers["Content-Type"].startswith("text/javascript")
    assert "no-cache" in static_js.headers["Cache-Control"]
    assert js_text == "export const x = 1;"
    assert index == 200 and traversal in (403, 404)
    assert set(others.values()) == {200} and reset == 200


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_cli_starts_and_streams():
    port = _free_port()
    proc = subprocess.Popen([sys.executable, str(ROOT / "tools" / "mock_feed_server.py"), "--port", str(port),
                             "--hybrid"], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

    async def scenario():
        async with aiohttp.ClientSession() as session:
            deadline = time.monotonic() + 20
            while True:
                try:
                    async with session.get(f"http://127.0.0.1:{port}/api/hello") as resp:
                        if resp.status == 200:
                            break
                except aiohttp.ClientConnectionError:
                    if time.monotonic() > deadline or proc.poll() is not None:
                        raise
                    await asyncio.sleep(0.2)
            async with session.ws_connect(f"http://127.0.0.1:{port}/ws") as ws:
                hello = await ws.receive_json(timeout=5)
                frame = None
                while frame is None:
                    msg = await ws.receive_json(timeout=5)
                    frame = msg if msg["type"] == "frame" else None
                return hello, frame

    try:
        hello, frame = asyncio.run(scenario())
    finally:
        proc.terminate()
        proc.wait(timeout=10)
    assert hello["mode"] == "HYBRID"
    assert frame["owner"] == {"fw_p03": "serial"}
