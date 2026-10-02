"""Tests for aerovolt.core.store.ChannelStore."""

import math
import time
from pathlib import Path

import numpy as np
import pytest

from aerovolt.core.catalog import Catalog
from aerovolt.core.events import EventBus
from aerovolt.core.model import ChannelDef
from aerovolt.core.store import ChannelStore

ROOT = Path(__file__).resolve().parents[1]


def small_catalog() -> Catalog:
    return Catalog([
        ChannelDef("fast", "Fast", "Pa", "aero", "g", 100.0, -1, 1),
        ChannelDef("slow", "Slow", "°C", "powertrain", "g", 1.0, -1, 1),
        ChannelDef("veryslow", "Very slow", "°C", "powertrain", "g", 0.1, -1, 1),
    ])


def test_latest_values_and_timestamps():
    store = ChannelStore(small_catalog())
    assert math.isnan(store.latest("fast"))
    store.update(1.0, {"fast": 2.5, "slow": -1.0})
    store.update(1.5, {"fast": 3.0})
    assert store.latest("fast") == 3.0
    assert store.latest_all() == {"fast": 3.0, "slow": -1.0}
    assert store.timestamp("slow") == 1.0
    assert store.age("fast", 2.0) == pytest.approx(0.5)
    assert store.age("veryslow", 2.0) == math.inf
    assert store.t == 1.5


def test_status_live_stale_missing():
    store = ChannelStore(small_catalog())
    store.update(10.0, {"fast": 0.0, "slow": 0.0, "veryslow": 0.0})
    # fast: max(0.5, 5/100) = 0.5 s; slow: 5 s; veryslow: 50 s
    assert store.status("fast", 10.4) == "live"
    assert store.status("fast", 10.6) == "stale"
    assert store.status("slow", 14.9) == "live"
    assert store.status("slow", 15.1) == "stale"
    assert store.status("veryslow", 59.0) == "live"
    assert store.status("unknown", 10.0) == "missing"
    assert store.statuses(10.6) == {"fast": "stale", "slow": "live", "veryslow": "live"}


def test_unknown_channels_kept_in_latest_but_not_history():
    store = ChannelStore(small_catalog())
    store.update(0.0, {"extra": 1.0})
    store.snapshot(0.0)
    t, series = store.history(["extra"], 10)
    assert store.latest("extra") == 1.0
    assert np.isnan(series["extra"]).all()


def test_snapshot_history_order_and_window():
    store = ChannelStore(small_catalog(), history_s=10.0, snapshot_hz=10.0)
    for k in range(50):
        t = k * 0.1
        store.update(t, {"fast": float(k)})
        store.snapshot(t)
    t, series = store.history(["fast", "slow"], seconds=1.0)
    assert t[0] == pytest.approx(3.9) and t[-1] == pytest.approx(4.9)
    assert list(series["fast"]) == [float(k) for k in range(39, 50)]
    assert np.isnan(series["slow"]).all()
    t_all, _ = store.history(["fast"])
    assert len(t_all) == 50


def test_ring_buffer_wraps_and_keeps_latest_capacity():
    store = ChannelStore(small_catalog(), history_s=2.0, snapshot_hz=10.0)
    assert store.capacity == 21
    for k in range(100):
        store.update(k * 0.1, {"fast": float(k)})
        store.snapshot(k * 0.1)
    assert len(store) == 21
    t, series = store.history(["fast"])
    assert list(series["fast"]) == [float(k) for k in range(79, 100)]
    assert np.all(np.diff(t) > 0)
    t, series = store.history(["fast"], seconds=0.5)
    assert list(series["fast"]) == [94.0, 95.0, 96.0, 97.0, 98.0, 99.0]
    assert t[-1] - t[0] == pytest.approx(0.5)


def test_history_returns_copies_and_reset():
    store = ChannelStore(small_catalog())
    store.update(0.0, {"fast": 1.0})
    store.snapshot(0.0)
    _, s = store.history(["fast"])
    s["fast"][0] = 99.0
    _, s2 = store.history(["fast"])
    assert s2["fast"][0] == 1.0
    store.reset()
    assert len(store) == 0 and store.latest_all() == {}
    t, s3 = store.history(["fast"], 5)
    assert t.size == 0 and s3["fast"].size == 0


def test_history_matrix():
    store = ChannelStore(small_catalog())
    for k in range(5):
        store.update(k, {"fast": k, "slow": -k})
        store.snapshot(k)
    t, m = store.history_matrix()
    assert m.shape == (5, 3)
    assert list(m[:, 1]) == [0, -1, -2, -3, -4]


def test_full_catalogue_at_20hz_for_300s_is_fast():
    catalog = Catalog.load(ROOT / "config" / "sensors.yaml")
    store = ChannelStore(catalog, history_s=300, snapshot_hz=20)
    ids = catalog.ids()
    values = {cid: 1.0 for cid in ids}
    start = time.perf_counter()
    for k in range(6000):  # 300 s at 20 Hz, with a full update per row
        store.update(k / 20, values)
        store.snapshot(k / 20)
    elapsed = time.perf_counter() - start
    assert len(store) == 6000
    assert elapsed < 10.0
    start = time.perf_counter()
    t, series = store.history(ids, seconds=60)
    assert time.perf_counter() - start < 0.5
    assert len(t) == 1201 and len(series) == len(ids)


def test_event_bus_filters_and_isolates_failures():
    bus = EventBus()
    got, laps = [], []

    def broken(_event):
        raise RuntimeError("boom")

    bus.subscribe(broken)
    unsub = bus.subscribe(got.append)
    bus.subscribe(laps.append, types=["lap"])
    bus.emit("alert", alert={"id": "x"})
    bus.publish({"type": "lap", "lap": {"lap": 1}})
    assert [e["type"] for e in got] == ["alert", "lap"]
    assert laps == [{"type": "lap", "lap": {"lap": 1}}]
    unsub()
    unsub()  # idempotent
    bus.emit("lap", lap={})
    assert len(got) == 2 and len(bus) == 2
