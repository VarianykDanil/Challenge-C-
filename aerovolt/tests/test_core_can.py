"""Tests for the CAN layout, tools/gen_can.py, can/aerovolt.dbc and the C++ header."""

import importlib.util
import random
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

cantools = pytest.importorskip("cantools")

from aerovolt.core.canutil import (  # noqa: E402
    CanSignal,
    is_sna,
    load_can_layout,
    raw_limits,
    scaled_to_raw,
    sna_raw,
)
from aerovolt.core.catalog import Catalog  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
DBC = ROOT / "can" / "aerovolt.dbc"
HEADER = ROOT / "firmware" / "sensor_node" / "include" / "aerovolt_can.h"


def _load_gen_can():
    spec = importlib.util.spec_from_file_location("gen_can", ROOT / "tools" / "gen_can.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


gen_can = _load_gen_can()


@pytest.fixture(scope="module")
def db():
    return cantools.database.load_file(str(DBC))


@pytest.fixture(scope="module")
def catalog():
    return Catalog.load(ROOT / "config" / "sensors.yaml")


@pytest.fixture(scope="module")
def layout():
    return load_can_layout(ROOT / "config" / "can_layout.yaml")


# ---------------------------------------------------------------------------- SNA helpers


def test_sna_helpers():
    assert sna_raw(16, True) == -32768
    assert sna_raw(16, False) == 0xFFFF
    assert sna_raw(8, False) == 255
    assert sna_raw(32, True) == -(2 ** 31)
    assert is_sna(-32768, 16, True) and is_sna(0x8000, 16, True)
    assert not is_sna(-32767, 16, True)
    assert is_sna(255, 8, False) and not is_sna(254, 8, False)
    assert not is_sna(1, 1, False)  # 1-bit flags have no SNA
    assert raw_limits(16, True) == (-32767, 32767)
    assert raw_limits(8, False) == (0, 254)
    assert raw_limits(1, False, has_sna=False) == (0, 1)


def test_rounding_is_half_to_even_like_cantools():
    assert scaled_to_raw(0.25, 0.1, 0) == 2  # 2.5 -> 2
    # double arithmetic matters: 0.35 / 0.1 = 3.4999999999999996 -> 3 (firmware must divide too)
    assert scaled_to_raw(0.35, 0.1, 0) == 3
    assert scaled_to_raw(-0.25, 0.5, 0) == 0  # -0.5 -> -0 (even)
    assert scaled_to_raw(0.75, 0.5, 0) == 2  # 1.5 -> 2
    assert scaled_to_raw(19.75, 0.5, -20) == 80  # 79.5 -> 80


def test_can_signal_encode_clamps_and_sna():
    sig = CanSignal("cell_t_00", 0, 8, False, 0.5, -20.0)
    assert sig.encode(float("nan")) == 255
    assert sig.encode(None) == 255
    assert sig.encode(1000.0) == 254  # clamped below SNA
    assert sig.encode(-100.0) == 0
    assert sig.decode(255) != sig.decode(255)  # NaN
    assert sig.decode(sig.encode(25.3)) == pytest.approx(25.5)
    flag = CanSignal("sdc_closed", 0, 1, False, 1.0, 0.0, has_sna=False)
    assert flag.sna is None and flag.decode(1) == 1.0
    with pytest.raises(ValueError):
        flag.encode(float("nan"))


# ---------------------------------------------------------------------------- layout & DBC


def test_layout_matches_spec_ids(layout):
    ids = {m.name: m.id for m in layout.messages}
    assert ids["AERO_FW_TAPS_A"] == 0x300 and ids["AERO_UT_TAPS_B"] == 0x307
    assert ids["AERO_AIR"] == 0x310 and ids["AERO_WING_LOADS"] == 0x312
    assert ids["IMU_GYRO"] == 0x331 and ids["GPS_VEL"] == 0x341 and ids["DRIVER"] == 0x351
    assert ids["INV_STATUS"] == 0x400 and ids["INV_TEMPS"] == 0x401 and ids["BMS_PACK"] == 0x410
    assert ids["BMS_CELL_V_00"] == 0x420 and ids["BMS_CELL_V_34"] == 0x442
    assert ids["BMS_CELL_T_0"] == 0x450 and ids["BMS_CELL_T_7"] == 0x457
    assert ids["COOLING"] == 0x460 and ids["SAFETY"] == 0x470
    assert len(layout.messages) == 67
    cells = layout.by_id[0x42B]
    assert [s.name for s in cells.signals] == ["cell_v_044", "cell_v_045", "cell_v_046", "cell_v_047"]
    assert len(layout.by_id[0x457].signals) == 4
    assert 0.1 < layout.bus_load() < 0.4


def test_every_raw_channel_is_exactly_one_signal(db, catalog):
    names = [s.name for m in db.messages for s in m.signals]
    assert len(names) == len(set(names))
    assert set(names) == set(catalog.raw_ids())


def test_signals_units_ranges_and_comments(db, catalog):
    for msg in db.messages:
        assert msg.comment, msg.name
        assert msg.cycle_time and msg.cycle_time > 0
        assert msg.length == 8 and not msg.is_extended_frame
        assert msg.senders[0] in {node.name for node in db.nodes}
        for sig in msg.signals:
            ch = catalog[sig.name]
            assert sig.unit == gen_can.dbc_unit(ch.unit), sig.name
            assert sig.byte_order == "little_endian"
            assert sig.comment and ch.name in sig.comment
            # the sensor range must be encodable (and never collide with SNA)
            assert sig.minimum <= ch.min and ch.max <= sig.maximum, sig.name


def test_specific_scalings(db):
    def sig(msg, name):
        return db.get_message_by_name(msg).get_signal_by_name(name)

    assert (sig("AERO_FW_TAPS_A", "fw_p01").scale, sig("AERO_FW_TAPS_A", "fw_p01").is_signed) == (0.1, True)
    amb = sig("AERO_AIR", "amb_press")
    assert (amb.length, amb.scale, amb.offset, amb.is_signed) == (16, 1, 50000, False)
    assert sig("IMU_ACCEL", "az").scale == 0.002
    assert (sig("GPS_POS", "gps_lat").length, sig("GPS_POS", "gps_lat").scale) == (32, 1e-7)
    t = sig("BMS_CELL_T_2", "cell_t_20")
    assert (t.length, t.scale, t.offset) == (8, 0.5, -20)
    flag = sig("SAFETY", "precharge_done")
    assert (flag.start, flag.length) == (7, 1)
    assert sig("SAFETY", "imd_iso_kohm").start == 16
    assert sig("INV_TEMPS", "inv_state").choices[3] == "driving"
    assert sig("AERO_FW_TAPS_A", "fw_p01").choices[-32768] == "SNA"


def _random_value(ch, sig, rng):
    if ch.unit in ("bool", "enum"):
        return float(rng.randint(int(ch.min), int(ch.max)))
    return rng.uniform(ch.min, ch.max)


def test_encode_decode_roundtrip_every_message(db, catalog):
    rng = random.Random(1)
    for msg in db.messages:
        for _ in range(20):
            values = {s.name: _random_value(catalog[s.name], s, rng) for s in msg.signals}
            data = msg.encode(values)
            decoded = msg.decode(data, decode_choices=False)
            for s in msg.signals:
                assert abs(decoded[s.name] - values[s.name]) <= s.scale / 2 + 1e-9, (msg.name, s.name)


def test_python_encoder_matches_cantools_bit_for_bit(db, layout, catalog):
    """canutil.CanSignal.encode (what our senders use) == cantools' raw integers."""
    rng = random.Random(2)
    for msg in layout.messages:
        dbc_msg = db.get_message_by_frame_id(msg.id)
        for _ in range(10):
            values = {s.name: _random_value(catalog[s.name], s, rng) for s in msg.signals}
            # include exact ties (x.5 raw) which expose round-half-even vs half-up
            s = msg.signals[0]
            if s.length > 1:
                tie = (round((values[s.name] - s.offset) / s.scale) + 0.5) * s.scale + s.offset
                values[s.name] = min(max(tie, s.phys_min), s.phys_max)
            raw = dbc_msg.decode(dbc_msg.encode(values), decode_choices=False, scaling=False)
            for s in msg.signals:
                assert s.encode(values[s.name]) == raw[s.name], (msg.name, s.name, values[s.name])


def test_sna_frames_decode_as_sna(db, layout):
    msg = layout.by_id[0x310]
    dbc_msg = db.get_message_by_frame_id(0x310)
    raw = {s.name: s.encode(float("nan")) for s in msg.signals}
    data = dbc_msg.encode(raw, scaling=False, strict=False)
    assert data[:2] == b"\x00\x80"  # pitot_dp: little-endian 0x8000
    back = dbc_msg.decode(data, decode_choices=False, scaling=False)
    for s in msg.signals:
        assert is_sna(back[s.name], s.length, s.is_signed)
        assert s.decode(back[s.name]) != s.decode(back[s.name])  # NaN


# ---------------------------------------------------------------------------- generator


def test_generated_files_are_up_to_date():
    result = subprocess.run([sys.executable, str(ROOT / "tools" / "gen_can.py"), "--check"],
                            capture_output=True, text=True, cwd=ROOT)
    assert result.returncode == 0, result.stdout + result.stderr


def test_check_detects_stale_output(tmp_path, monkeypatch):
    stale = tmp_path / "aerovolt.dbc"
    stale.write_bytes(DBC.read_bytes() + b"\n")
    monkeypatch.setattr(gen_can, "DBC_PATH", stale)
    monkeypatch.setattr(gen_can, "HEADER_PATH", HEADER)
    assert gen_can.main(["--check"]) == 1
    monkeypatch.setattr(gen_can, "DBC_PATH", tmp_path / "missing.dbc")
    assert gen_can.main(["--check"]) == 1


def test_generation_is_deterministic():
    first = gen_can.generate()
    second = gen_can.generate()
    assert first == second
    assert b"GENERATED - DO NOT EDIT" in first[HEADER]


def test_number_formatting():
    assert gen_can.fmt_num(1e-7) == "0.0000001"
    assert gen_can.fmt_num(0.1 * 32767) == "3276.7"
    assert gen_can.fmt_num(50000.0) == "50000"
    assert gen_can.dbc_unit("kΩ") == "kOhm"


@pytest.mark.skipif(shutil.which("g++") is None, reason="g++ not installed")
def test_header_compiles_and_matches_layout(tmp_path, layout):
    program = tmp_path / "dump.cpp"
    program.write_text("""
        #include "aerovolt_can.h"
        #include <cstdio>
        using namespace aerovolt::can;
        int main() {
            for (size_t m = 0; m < MESSAGE_COUNT; ++m) {
                const MessageDef& msg = MESSAGES[m];
                std::printf("M %u %s %u %u %u\\n", (unsigned)msg.id, msg.name, (unsigned)msg.dlc,
                            (unsigned)msg.cycle_ms, (unsigned)msg.signal_count);
                for (uint8_t i = 0; i < msg.signal_count; ++i) {
                    const SignalDef& s = msg.signals[i];
                    std::printf("S %s %u %u %d %.17g %.17g %d %lld\\n", s.name, (unsigned)s.start_bit,
                                (unsigned)s.length, (int)s.is_signed, s.scale, s.offset, (int)s.has_sna,
                                (long long)sna_raw(s));
                }
            }
            const SignalRef r = find_channel("cell_v_047");
            std::printf("F %u %u\\n", (unsigned)r.message->id, (unsigned)r.index);
            std::printf("N %d\\n", find_message(0x7FF) == nullptr);
            return 0;
        }
    """)
    exe = tmp_path / "dump"
    subprocess.run(["g++", "-std=c++17", "-Wall", "-Wextra", "-Werror", f"-I{HEADER.parent}", str(program),
                    "-o", str(exe)], check=True, capture_output=True)
    lines = subprocess.run([str(exe)], check=True, capture_output=True, text=True).stdout.splitlines()
    expected = []
    for msg in layout.messages:
        expected.append(f"M {msg.id} {msg.name} {msg.dlc} {msg.cycle_ms} {len(msg.signals)}")
        for s in msg.signals:
            expected.append(f"S {s.name} {s.start_bit} {s.length} {int(s.is_signed)} {s.scale!r} {s.offset!r} "
                            f"{int(s.has_sna)} {sna_raw(s.length, s.is_signed)}")
    got = [ln for ln in lines if ln[0] in "MS"]
    assert len(got) == len(expected)
    for g, e in zip(got, expected):
        gp, ep = g.split(), e.split()
        if gp[0] == "S":
            assert gp[:5] == ep[:5] and gp[7:] == ep[7:]
            assert float(gp[5]) == float(ep[5]) and float(gp[6]) == float(ep[6])
        else:
            assert gp == ep
    assert "F 1067 3" in lines and "N 1" in lines
