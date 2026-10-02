"""The real firmware (src/) running on the PC against emulated sensors (firmware-in-the-loop).

``make -C firmware/sensor_node/test/host tools`` builds ``firmware_sim_<profile>``: the
firmware's own ``setup()``/``loop()`` compiled against small fakes of the Arduino API, with
emulated SDP sensors behind a TCA9548A mux, a BME280, pots and an HX711. Here its serial
output is parsed with the *host's* parser (``aerovolt.sources.protocol``) and its CAN frames
are decoded with the *host's* DBC decoder (``aerovolt.sources.canmap``), i.e. exactly what
AeroVolt would see from a real node:

* every line has a valid checksum and parses; the hello lists catalogue channel ids;
* pressure values follow the emulated truth; an unplugged sensor gives ``$AVS`` error,
  ``nan`` on serial and SNA on CAN (dropped by the decoder), and recovers by itself;
* frames carry only the node's own signals - the others are SNA and never decoded.
"""

from __future__ import annotations

import math
import shutil
import subprocess
from pathlib import Path

import pytest

from aerovolt.core.catalog import Catalog
from aerovolt.sources.protocol import parse_line

pytest.importorskip("cantools")
from aerovolt.sources.canmap import CanMap  # noqa: E402 - needs cantools

ROOT = Path(__file__).resolve().parents[1]
HOST_DIR = ROOT / "firmware" / "sensor_node" / "test" / "host"
FRONT_CHANNELS = [f"fw_p{i:02d}" for i in range(1, 9)] + ["pitot_dp", "amb_temp", "amb_press", "amb_rh",
                                                         "damper_fl", "damper_fr", "fw_load"]
BENCH_CHANNELS = ["fw_p03", "amb_temp", "amb_press", "amb_rh"]


def true_pressure(channel: str, t: float) -> float:
    """Same model as test/host/sim/sim_main.cpp."""
    if channel == "pitot_dp":
        return 350.0 + 20.0 * math.sin(2 * math.pi * 0.25 * t)
    n = int(channel[-2:])
    return -55.0 * n + 25.0 * math.sin(2 * math.pi * 0.25 * t + n)


@pytest.fixture(scope="module")
def sims() -> Path:
    if shutil.which("make") is None or shutil.which("g++") is None:
        pytest.skip("make and g++ are needed to build the firmware simulation")
    proc = subprocess.run(["make", "-C", str(HOST_DIR), "tools"], capture_output=True, text=True, timeout=600)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    return HOST_DIR / "build"


@pytest.fixture(scope="module")
def catalog() -> Catalog:
    return Catalog.load(ROOT / "config" / "sensors.yaml")


@pytest.fixture(scope="module")
def canmap() -> CanMap:
    return CanMap.from_dbc(ROOT / "can" / "aerovolt.dbc")


def run_sim(binary: Path, tmp: Path, *args: str) -> tuple[list, list[tuple[float, int, bytes]]]:
    serial_path, can_path = tmp / f"{binary.name}.serial", tmp / f"{binary.name}.can"
    proc = subprocess.run([str(binary), "--serial-out", str(serial_path), "--can-out", str(can_path), *args],
                          capture_output=True, text=True, timeout=120)
    assert proc.returncode == 0, proc.stderr
    raw = serial_path.read_bytes()
    assert raw.endswith(b"\r\n")
    lines = [parse_line(line, raise_errors=True) for line in raw.split(b"\r\n")[:-1]]
    assert all(p is not None for p in lines)
    frames = []
    for row in can_path.read_text().splitlines():
        t_us, frame_id, data = row.split()
        frames.append((int(t_us) / 1e6, int(frame_id, 16), bytes.fromhex(data)))
    return lines, frames


def test_front_node_serial_and_can(sims: Path, tmp_path: Path, catalog: Catalog, canmap: CanMap) -> None:
    lines, frames = run_sim(sims / "firmware_sim_front", tmp_path, "--seconds", "11", "--disconnect", "fw_p05@3:6")
    hellos = [p for p in lines if p.kind == "hello"]
    assert lines[0].kind == "hello" and len(hellos) == 3  # boot, 5 s, 10 s
    assert hellos[0].node == "AERO_FRONT" and hellos[0].channels == FRONT_CHANNELS
    assert all(ch in catalog and not catalog[ch].derived for ch in FRONT_CHANNELS)

    status = [p for p in lines if p.kind == "status"]
    assert status[0].status == "ok" and status[0].message.startswith("boot: 9/9 pressure sensors")
    errors = [s for s in status if s.status == "error" and s.message.startswith("fw_p05:")]
    assert errors and 3000 <= errors[0].ms < 3300
    assert any(s.status == "ok" and s.message == "fw_p05: recovered" and 6000 <= s.ms < 7300 for s in status)
    assert any(s.status == "error" and s.message == "failing: fw_p05" for s in status)  # reminder with the hello

    data = [p for p in lines if p.kind == "data"]
    for p in data:
        t = p.ms / 1000.0
        for ch, v in p.values.items():
            assert ch in FRONT_CHANNELS
            if ch == "fw_p05" and 3.3 <= t < 6.0:
                assert math.isnan(v)
            elif ch.startswith("fw_p") or ch == "pitot_dp":
                if not math.isnan(v):
                    assert v == pytest.approx(true_pressure(ch, t), abs=3.0)

    # CAN: the host decoder sees only this node's signals (SNA elsewhere is dropped).
    seen: set[str] = set()
    for t, frame_id, payload in frames:
        decoded = canmap.decode(frame_id, payload)
        assert set(decoded) <= set(FRONT_CHANNELS), decoded
        seen |= set(decoded)
        if "fw_p05" in decoded:
            assert not 3.1 <= t < 6.0
            assert decoded["fw_p05"] == pytest.approx(true_pressure("fw_p05", t), abs=3.0)
        if frame_id == 0x320:  # SUSP_DAMPERS: front node owns fl/fr only
            assert set(decoded) == {"damper_fl", "damper_fr"}
    assert seen == set(FRONT_CHANNELS)
    ids = {f[1] for f in frames}
    assert ids == {0x300, 0x301, 0x310, 0x312, 0x320}
    per_id = {i: sum(1 for f in frames if f[1] == i) for i in ids}
    assert per_id[0x300] == pytest.approx(11 / 0.020, abs=5)   # 50 Hz
    assert per_id[0x320] == pytest.approx(11 / 0.010, abs=8)   # 100 Hz


def test_bench_node_matches_hybrid_demo(sims: Path, tmp_path: Path, canmap: CanMap) -> None:
    lines, frames = run_sim(sims / "firmware_sim_bench", tmp_path, "--seconds", "6")
    assert lines[0].kind == "hello" and lines[0].node == "BENCH" and lines[0].channels == BENCH_CHANNELS
    data = [p for p in lines if p.kind == "data"]
    taps = [(p.ms / 1000.0, p.values["fw_p03"]) for p in data if "fw_p03" in p.values]
    assert len(taps) >= 0.98 * 6 / 0.020  # 50 lines per second over USB
    assert all(v == pytest.approx(true_pressure("fw_p03", t), abs=3.0) for t, v in taps)
    ambient = [p.values for p in data if "amb_press" in p.values]
    assert 5 <= len(ambient) <= 7  # 1 Hz
    assert ambient[-1]["amb_temp"] == pytest.approx(25.08) and ambient[-1]["amb_press"] == pytest.approx(100653, abs=1)
    assert 0 < ambient[-1]["amb_rh"] < 100

    # On CAN the bench node owns one tap of AERO_FW_TAPS_A and the ambient part of AERO_AIR.
    for _, frame_id, payload in frames:
        decoded = canmap.decode(frame_id, payload)
        if frame_id == 0x300:
            assert set(decoded) <= {"fw_p03"}
        else:
            assert frame_id == 0x310 and set(decoded) <= {"amb_temp", "amb_press", "amb_rh"}


def test_serial_only_build_sends_the_same_lines(sims: Path, tmp_path: Path) -> None:
    """nano_serial (AV_USE_CAN=0) prints exactly what the CAN-enabled bench build prints."""
    with_can, frames = run_sim(sims / "firmware_sim_bench", tmp_path, "--seconds", "3")
    serial_only, no_frames = run_sim(sims / "firmware_sim_nano", tmp_path, "--seconds", "3")
    assert frames and not no_frames
    assert [(p.kind, p.ms, p.values, p.channels) for p in with_can] == \
           [(p.kind, p.ms, p.values, p.channels) for p in serial_only]
    boot_can = next(p.message for p in with_can if p.kind == "status")
    boot_serial = next(p.message for p in serial_only if p.kind == "status")
    assert boot_can == boot_serial + ", CAN on" == "boot: 1/1 pressure sensors, ambient ok, CAN on"


def test_crc_noise_is_reported_not_sent(sims: Path, tmp_path: Path) -> None:
    lines, _ = run_sim(sims / "firmware_sim_bench", tmp_path, "--seconds", "4", "--crc-noise", "fw_p03@1:2")
    errors = [p for p in lines if p.kind == "status" and p.status == "error"]
    assert errors and errors[0].message.startswith("fw_p03: CRC errors") and 1000 <= errors[0].ms < 1200
    for p in lines:
        if p.kind == "data" and "fw_p03" in p.values and not math.isnan(p.values["fw_p03"]):
            assert p.values["fw_p03"] == pytest.approx(true_pressure("fw_p03", p.ms / 1000.0), abs=3.0)
    assert any(p.kind == "status" and p.message == "fw_p03: recovered" for p in lines)
