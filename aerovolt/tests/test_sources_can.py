"""CAN: DBC mapping (SNA handling, encode/decode) and CanSource on python-can's virtual bus."""

from __future__ import annotations

import asyncio
import math
import time
import uuid
from typing import Callable

import pytest

can = pytest.importorskip("can")
pytest.importorskip("cantools")

from aerovolt.core.canutil import load_can_layout, sna_raw  # noqa: E402
from aerovolt.core.config import PROJECT_ROOT, load_config  # noqa: E402
from aerovolt.core.source import SessionContext, create_source  # noqa: E402
from aerovolt.sources.can_source import frame_bits  # noqa: E402
from aerovolt.sources.canmap import CanMap, UnknownFrameError  # noqa: E402

DBC = PROJECT_ROOT / "can" / "aerovolt.dbc"
LAYOUT = PROJECT_ROOT / "config" / "can_layout.yaml"


@pytest.fixture(scope="module")
def cmap() -> CanMap:
    return CanMap.from_dbc(DBC)


@pytest.fixture(scope="module")
def config():
    return load_config(None)


# --------------------------------------------------------------------------------------
# CanMap
# --------------------------------------------------------------------------------------


def test_dbc_signals_are_catalogue_channels(cmap, config):
    names = cmap.signal_names()
    assert len(names) == len(set(names))
    assert set(names) <= set(config.catalog.raw_ids())
    assert set(names) == set(load_can_layout(LAYOUT).signal_names())


def test_round_trip_aero_taps_with_scaling(cmap):
    values = {"fw_p01": -1234.5, "fw_p02": 0.0, "fw_p03": 812.3, "fw_p04": -0.1}
    data = cmap.encode("AERO_FW_TAPS_A", values)
    assert len(data) == 8
    assert cmap.decode(0x300, data) == pytest.approx(values)


def test_unowned_and_nan_signals_are_sna_and_dropped(cmap):
    # A node that only measures fw_p03 fills the other taps of the frame with SNA.
    data = cmap.encode(0x300, {"fw_p03": -412.5})
    raw = cmap.frame(0x300).message.decode(data, decode_choices=False, scaling=False)
    assert raw["fw_p01"] == sna_raw(16, True) == -32768
    assert cmap.decode(0x300, data) == {"fw_p03": -412.5}
    data = cmap.encode(0x300, {"fw_p03": float("nan"), "fw_p04": 1.0})
    assert cmap.decode(0x300, data) == {"fw_p04": 1.0}


def test_unsigned_sna_and_offset_signals(cmap):
    # AERO_AIR: amb_press u16 1 Pa offset 50000; amb_rh u8 0.5 %.
    data = cmap.encode("AERO_AIR", {"amb_press": 101325.0, "amb_temp": 18.43})
    decoded = cmap.decode(0x310, data)
    assert decoded["amb_press"] == 101325.0
    assert decoded["amb_temp"] == pytest.approx(18.43)
    assert "amb_rh" not in decoded and "pitot_dp" not in decoded  # SNA: 0xFF / 0x8000


def test_values_are_rounded_half_even_and_clamped(cmap):
    decoded = cmap.decode(0x300, cmap.encode(0x300, {"fw_p01": 0.25, "fw_p02": 1e9, "fw_p03": -1e9}))
    assert decoded["fw_p01"] == pytest.approx(0.2)  # 2.5 raw -> 2 (half to even), like cantools
    assert decoded["fw_p02"] == pytest.approx(3276.7)  # clamped below the SNA code
    assert decoded["fw_p03"] == pytest.approx(-3276.7)  # -32768 is SNA, so the minimum is -32767


def test_flags_have_no_sna(cmap):
    values = {"sdc_closed": 1, "imd_ok": 1, "ams_ok": 0, "bspd_ok": 1, "apps_plaus_ok": 1,
              "air_pos_closed": 1, "air_neg_closed": 1, "precharge_done": 1, "tsal_state": 1}
    decoded = cmap.decode(0x470, cmap.encode("SAFETY", values))
    assert decoded["ams_ok"] == 0 and decoded["sdc_closed"] == 1
    assert "imd_iso_kohm" not in decoded  # u16 SNA
    # Missing flags are sent as 0, never as an invalid code.
    assert cmap.decode(0x470, cmap.encode("SAFETY", {}))["sdc_closed"] == 0


def test_cell_frames_and_encode_all(cmap):
    values = {f"cell_v_{k:03d}": 3.6 + k * 0.001 for k in range(8)}
    frames = cmap.encode_all(values)
    assert [fid for fid, _ in frames] == [0x420, 0x421]
    decoded = {}
    for fid, data in frames:
        decoded.update(cmap.decode(fid, data))
    assert decoded == pytest.approx(values)
    t = cmap.decode(0x450, cmap.encode(0x450, {"cell_t_00": 35.5, "cell_t_01": -20.0}))
    assert t == pytest.approx({"cell_t_00": 35.5, "cell_t_01": -20.0})


def test_channel_filter_and_errors(config):
    only = CanMap.from_dbc(DBC, channels=["fw_p03"])
    data = only.encode(0x300, {"fw_p01": 1.0, "fw_p03": 2.0})
    assert only.decode(0x300, data) == {"fw_p03": 2.0}
    assert only.decode(0x301, only.encode(0x301, {"fw_p05": 1.0})) == {}
    with pytest.raises(UnknownFrameError):
        only.decode(0x7FF, bytes(8))
    with pytest.raises(ValueError):
        only.decode(0x300, b"\x01\x02")  # truncated payload
    assert 0x300 in only and 0x7FF not in only


def test_frame_bits_worst_case():
    assert frame_bits(8) == 135
    assert frame_bits(0) == 47 + 8


# --------------------------------------------------------------------------------------
# CanSource on the virtual bus
# --------------------------------------------------------------------------------------


async def wait_until(cond: Callable[[], bool], timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not cond():
        if time.monotonic() > deadline:
            raise AssertionError("condition not reached in time")
        await asyncio.sleep(0.01)


def make_ctx(config) -> SessionContext:
    return SessionContext(config=config, catalog=config.catalog, vehicle=config.vehicle, root=config.root,
                          clock=lambda: 7.25)


def test_can_source_receives_decodes_and_counts(config, cmap):
    channel = f"aerovolt-test-{uuid.uuid4().hex[:8]}"
    src = create_source({"type": "can", "interface": "virtual", "channel": channel, "bitrate": 1_000_000,
                         "dbc": "can/aerovolt.dbc"}, make_ctx(config))
    assert src.kind == "can"
    received: list[tuple[float, dict[str, float]]] = []

    async def main():
        task = asyncio.create_task(src.run(lambda t, v: received.append((t, dict(v)))))
        try:
            await wait_until(lambda: src.status == "running")
            sender = can.Bus(interface="virtual", channel=channel)
            try:
                def send(fid: int, data: bytes, **kw) -> None:
                    sender.send(can.Message(arbitration_id=fid, data=data, is_extended_id=False, **kw))

                send(0x300, cmap.encode(0x300, {"fw_p03": -412.5}))  # others SNA
                send(0x410, cmap.encode("BMS_PACK", {"pack_voltage": 560.2, "pack_current": -12.3,
                                                     "bms_soc": 87.5, "bms_state": 2, "bms_fault": 0}))
                send(0x123, bytes(8))                                    # not in the DBC
                sender.send(can.Message(arbitration_id=0x18FF0001, data=bytes(8), is_extended_id=True))
                send(0x300, b"\x00\x01")                                 # too short
                sender.send(can.Message(is_error_frame=True, arbitration_id=0, data=b""))
                for i in range(50):
                    send(0x420, cmap.encode(0x420, {"cell_v_000": 3.700 + i * 0.001}))
                await wait_until(lambda: src.stats["frames"] >= 55)
                await asyncio.sleep(0.6)
                send(0x420, cmap.encode(0x420, {"cell_v_000": 3.9}))
                await wait_until(lambda: src.stats["frames"] >= 56)
            finally:
                sender.shutdown()
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(main())
    merged: dict[str, float] = {}
    for t, values in received:
        assert t == 7.25  # arrival time from the session clock
        merged.update(values)
    assert received[0][1] == {"fw_p03": -412.5}  # SNA signals never reach the store
    assert merged["pack_voltage"] == pytest.approx(560.2)
    assert merged["pack_current"] == pytest.approx(-12.3)
    assert merged["bms_soc"] == 87.5 and merged["bms_state"] == 2
    assert merged["cell_v_000"] == pytest.approx(3.9)
    assert "cell_v_001" not in merged
    s = src.stats
    assert s["unknown_ids"] == 2 and s["unknown_id_list"] == ["0x123", "0x18FF0001"]
    assert s["decode_errors"] == 1
    assert s["error_frames"] == 1
    assert s["frames"] == 56
    assert s["frames_per_s"] > 0 and s["bus_load_pct"] > 0
    assert "virtual" in src.info()["detail"]


def test_can_source_waits_when_the_interface_is_missing(config):
    src = create_source({"type": "can", "interface": "socketcan", "channel": "aerovolt_nonexistent0",
                         "reconnect_s": 0.05}, make_ctx(config))

    async def main():
        task = asyncio.create_task(src.run(lambda t, v: None))
        try:
            await wait_until(lambda: "not available" in src.detail)
            await asyncio.sleep(0.15)  # retries without raising
            assert not task.done()
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(main())
    assert src.status == "waiting"
    assert "ip link set aerovolt_nonexistent0 up" in src.detail


def test_can_source_channel_filter(config, cmap):
    channel = f"aerovolt-test-{uuid.uuid4().hex[:8]}"
    src = create_source({"type": "can", "interface": "virtual", "channel": channel, "channels": ["fw_p03"]},
                        make_ctx(config))
    received: list[dict[str, float]] = []

    async def main():
        task = asyncio.create_task(src.run(lambda t, v: received.append(dict(v))))
        try:
            await wait_until(lambda: src.status == "running")
            with can.Bus(interface="virtual", channel=channel) as sender:
                sender.send(can.Message(arbitration_id=0x300, is_extended_id=False,
                                        data=cmap.encode(0x300, {"fw_p01": 1.0, "fw_p03": 3.0})))
                sender.send(can.Message(arbitration_id=0x301, is_extended_id=False,
                                        data=cmap.encode(0x301, {"fw_p05": 5.0})))
                await wait_until(lambda: src.stats["frames"] >= 2)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(main())
    assert received == [{"fw_p03": 3.0}]
    assert src.provides() == {"fw_p03"}
    assert not math.isnan(src.stats["frames_per_s"])
