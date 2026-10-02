"""Firmware <-> DBC <-> Python agreement, bit for bit (SPEC section 11).

The sensor-node firmware packs CAN frames with its own C++ code (``lib/avcore``) from the
generated header ``aerovolt_can.h``; the computer decodes them with cantools from the
generated ``can/aerovolt.dbc``. These tests compile the firmware's host tools and check that
both sides produce *identical bytes* for:

* random in-range values of every signal of every message (all signals present, and a
  random subset present with the others sent as SNA - what a node that owns only part of a
  frame does), including values within a hair of a rounding tie;
* exact ties (round half to even), values out of range (saturation, never wrapping into
  the SNA code) and NaN (SNA), against the shared encoder ``CanSignal.encode``;

and that every ``$AV`` / ``$AVH`` / ``$AVS`` line the firmware's writer prints is accepted
by ``aerovolt.sources.protocol.parse_line`` with the right values.
"""

from __future__ import annotations

import math
import random
import shutil
import subprocess
from pathlib import Path

import pytest

from aerovolt.core.canutil import CanSignal, raw_limits
from aerovolt.sources.protocol import parse_line

cantools = pytest.importorskip("cantools")

ROOT = Path(__file__).resolve().parents[1]
HOST_DIR = ROOT / "firmware" / "sensor_node" / "test" / "host"
BUILD = HOST_DIR / "build"
DBC = ROOT / "can" / "aerovolt.dbc"


@pytest.fixture(scope="module")
def host_tools() -> Path:
    """Build pack_vectors / av_lines with the firmware's strict host Makefile."""
    if shutil.which("make") is None or shutil.which("g++") is None:
        pytest.skip("make and g++ are needed to build the firmware host tools")
    proc = subprocess.run(["make", "-C", str(HOST_DIR), "build/pack_vectors", "build/av_lines"],
                          capture_output=True, text=True, timeout=300)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    return BUILD


@pytest.fixture(scope="module")
def db():
    return cantools.database.load_file(str(DBC))


def run_tool(tool: Path, lines: list[str]) -> list[str]:
    proc = subprocess.run([str(tool)], input="\n".join(lines) + "\n", capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stdout[-2000:] + proc.stderr[-2000:]
    return proc.stdout.splitlines()


def has_sna(sig) -> bool:
    return sig.length > 1


def random_value(sig, rng: random.Random) -> float:
    """A physical value inside the signal's valid range (SNA excluded), often close to a tie."""
    lo, hi = raw_limits(sig.length, sig.is_signed, has_sna(sig))
    raw = rng.randint(lo, hi)
    kind = rng.random()
    if kind < 0.2:
        frac = 0.0
    elif kind < 0.4:
        frac = rng.choice((-0.5, 0.5)) + rng.choice((-1e-9, 1e-9))  # a hair from a tie
    else:
        frac = rng.uniform(-0.499, 0.499)
    value = (raw + frac) * sig.scale + sig.offset
    return min(max(value, sig.minimum), sig.maximum)


def cantools_frame(db, name: str, values: dict[str, float]) -> str:
    """cantools encoding of `values` with SNA ('SNA' choice) / 0 for omitted signals."""
    msg = db.get_message_by_name(name)
    data = {s.name: values.get(s.name, "SNA" if has_sna(s) else 0) for s in msg.signals}
    return msg.encode(data, scaling=True, strict=True, padding=False).ljust(8, b"\x00").hex().upper()


def vector_line(name: str, values: dict[str, float]) -> str:
    return " ".join([name, *(f"{k}={v!r}" for k, v in values.items())])


def test_every_message_matches_cantools(host_tools: Path, db) -> None:
    rng = random.Random(20261002)
    lines: list[str] = []
    expected: list[str] = []
    for msg in db.messages:
        for rep in range(60):
            if rep % 3 == 0:  # a random subset: the rest must be SNA
                chosen = [s for s in msg.signals if rng.random() < 0.5]
            else:
                chosen = list(msg.signals)
            values = {s.name: random_value(s, rng) for s in chosen}
            lines.append(vector_line(msg.name, values))
            expected.append(cantools_frame(db, msg.name, values))
    got = run_tool(host_tools / "pack_vectors", lines)
    assert len(got) == len(expected)
    mismatches = [(line, g, e) for line, g, e in zip(lines, got, expected) if g != e]
    assert not mismatches, f"{len(mismatches)} of {len(lines)} frames differ, first: {mismatches[:3]}"
    assert len(db.messages) == 67 and len(lines) == 67 * 60


def test_only_sna_frames(host_tools: Path, db) -> None:
    """A frame with no values: every multi-bit signal SNA, flags 0, unused bits 0."""
    names = [m.name for m in db.messages]
    got = run_tool(host_tools / "pack_vectors", names)
    assert got == [cantools_frame(db, n, {}) for n in names]
    assert got[names.index("AERO_FW_TAPS_A")] == "0080008000800080"


def test_ties_round_half_to_even(host_tools: Path, db) -> None:
    cases = [("AERO_WING_LOADS", "fw_load", v) for v in (12.5, 13.5, -12.5, -13.5, 0.5, -0.5)]
    cases += [("AERO_AIR", "amb_press", v) for v in (101325.5, 101326.5, 50000.5)]
    cases += [("AERO_AIR", "amb_rh", v) for v in (46.25, 46.75, 0.25)]  # 0.5 % scale: x.25 is a tie
    cases += [("INV_STATUS", "mot_speed", v) for v in (1000.5, 1001.5, -2.5)]
    lines = [f"{m} {s}={v!r}" for m, s, v in cases]
    expected = [cantools_frame(db, m, {s: v}) for m, s, v in cases]
    assert run_tool(host_tools / "pack_vectors", lines) == expected


def test_saturation_and_nan_match_shared_encoder(host_tools: Path, db) -> None:
    """Out-of-range values clamp to the valid range (never the SNA code); NaN is SNA.

    cantools' strict mode refuses such values, so the reference is the project's shared
    encoder ``CanSignal.encode`` (core/canutil.py) followed by cantools raw packing.
    """
    lines, expected = [], []
    for msg in db.messages:
        shared = {s.name: CanSignal(s.name, s.start, s.length, s.is_signed, s.scale, s.offset, has_sna(s))
                  for s in msg.signals}
        empty_frame = {name: (cs.sna if cs.has_sna else 0) for name, cs in shared.items()}
        for sig in msg.signals:
            cs = shared[sig.name]
            for value in (1e12, -1e12, sig.maximum + 10 * sig.scale, sig.minimum - 10 * sig.scale, float("nan")):
                if math.isnan(value) and not cs.has_sna:
                    continue
                raw = dict(empty_frame)
                raw[sig.name] = cs.encode(value)
                if not math.isnan(value):
                    assert raw[sig.name] != cs.sna, f"{sig.name}: saturated value must not be SNA"
                lines.append(f"{msg.name} {sig.name}={value!r}")
                expected.append(msg.encode(raw, scaling=False, strict=False, padding=False).ljust(8, b"\x00").hex().upper())
    assert run_tool(host_tools / "pack_vectors", lines) == expected


def test_decoding_back_with_cantools(host_tools: Path, db) -> None:
    got = run_tool(host_tools / "pack_vectors", ["AERO_FW_TAPS_A fw_p03=-412.5", "GPS_POS gps_lat=52.0786 gps_lon=-1.0169",
                                                  "SAFETY sdc_closed=1 imd_iso_kohm=2000 tsal_state=1"])
    fw = db.decode_message("AERO_FW_TAPS_A", bytes.fromhex(got[0]), decode_choices=True)
    assert fw["fw_p03"] == pytest.approx(-412.5) and str(fw["fw_p01"]) == "SNA"
    gps = db.decode_message("GPS_POS", bytes.fromhex(got[1]))
    assert gps["gps_lat"] == pytest.approx(52.0786, abs=1e-7) and gps["gps_lon"] == pytest.approx(-1.0169, abs=1e-7)
    safety = db.decode_message("SAFETY", bytes.fromhex(got[2]), decode_choices=False)
    assert safety["sdc_closed"] == 1 and safety["imd_ok"] == 0 and safety["imd_iso_kohm"] == 2000


def test_bad_input_is_reported(host_tools: Path) -> None:
    proc = subprocess.run([str(host_tools / "pack_vectors")], input="NO_SUCH_MSG a=1\nAERO_AIR fw_p01=3\nAERO_AIR pitot_dp=x\n",
                          capture_output=True, text=True, timeout=30)
    assert proc.returncode == 1
    assert [line.split()[0] for line in proc.stdout.splitlines()] == ["ERROR"] * 3


# ---------------------------------------------------------------------------------------------
# $AV serial lines
# ---------------------------------------------------------------------------------------------


def test_av_lines_parse_with_protocol(host_tools: Path) -> None:
    rng = random.Random(7)
    channels = ["fw_p03", "pitot_dp", "amb_temp", "amb_press", "amb_rh", "damper_fl", "fw_load", "cell_v_047"]
    commands, expected = [], []
    for i in range(300):
        picked = rng.sample(channels, rng.randint(1, len(channels)))
        values = {}
        items = []
        for ch in picked:
            decimals = rng.randint(0, 4)
            v = float("nan") if rng.random() < 0.05 else rng.uniform(-5000, 110000)
            values[ch] = (v, decimals)
            items.append(f"{ch}={v!r}:{decimals}")
        node = rng.choice(["BENCH", "AERO_FRONT", "N1"])
        ms = rng.randint(0, 2**32 - 1)
        commands.append(f"DATA {node} {ms} " + " ".join(items))
        expected.append((node, ms, values))
    out = run_tool(host_tools / "av_lines", commands)
    assert len(out) == len(expected)
    for line, (node, ms, values) in zip(out, expected):
        parsed = parse_line(line + "\n", raise_errors=True)
        assert parsed is not None and parsed.kind == "data"
        assert parsed.node == node and parsed.ms == ms
        assert list(parsed.values) == list(values)
        for ch, (v, decimals) in values.items():
            if math.isnan(v):
                assert math.isnan(parsed.values[ch])
            else:
                assert parsed.values[ch] == pytest.approx(v, abs=0.5 * 10 ** -decimals + 1e-9)


def test_hello_and_status_parse_with_protocol(host_tools: Path) -> None:
    out = run_tool(host_tools / "av_lines", [
        "HELLO AERO_FRONT 1.0.0 fw_p01 fw_p02 pitot_dp amb_temp",
        "STATUS AERO_FRONT 1234 error fw_p03: no answer at 0x25 (mux channel 2)",
        "STATUS BENCH 99 ok boot: 1/1 pressure sensors, ambient ok",
        "STATUS BENCH 100 warn fw_p03: over range (> 500 Pa)",
        "DATA N1 0 a=1:0",
    ])
    hello = parse_line(out[0], raise_errors=True)
    assert hello.kind == "hello" and hello.node == "AERO_FRONT" and hello.fw_version == "1.0.0"
    assert hello.channels == ["fw_p01", "fw_p02", "pitot_dp", "amb_temp"]
    err = parse_line(out[1], raise_errors=True)
    assert (err.kind, err.status, err.ms, err.message) == ("status", "error", 1234, "fw_p03: no answer at 0x25 (mux channel 2)")
    ok = parse_line(out[2], raise_errors=True)
    assert ok.status == "ok" and ok.message == "boot: 1/1 pressure sensors, ambient ok"  # commas survive
    assert parse_line(out[3], raise_errors=True).status == "warn"
    assert out[4] == "$AV,N1,0,a=1*19"  # SPEC 7.1 worked example


def test_corrupted_firmware_line_is_rejected(host_tools: Path) -> None:
    line = run_tool(host_tools / "av_lines", ["DATA BENCH 5 fw_p03=-412.5:1"])[0]
    assert parse_line(line) is not None
    corrupted = line.replace("-412.5", "-412.6")
    assert parse_line(corrupted) is None  # checksum catches the flipped digit
