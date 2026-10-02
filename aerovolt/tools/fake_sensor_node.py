#!/usr/bin/env python3
"""Emulate an AeroVolt sensor node - no hardware needed (SPEC section 12).

It behaves like the firmware in ``firmware/sensor_node``: ``$AVH`` hello at start and every
5 s, ``$AV`` data lines at the channels' rates, ``$AVS`` status lines (boot, sensor errors,
recovery) - or the same values as CAN frames packed with ``can/aerovolt.dbc`` (SNA in the
signals it does not own).

Where the lines go::

    --pty                 a pseudo-terminal (Linux/macOS): prints the device path AND the exact
                          command that starts AeroVolt with it (sim + this node = the Phase-2
                          bench demo, without the bench)
    --port /dev/ttyUSB1   an existing serial port (e.g. one end of a USB null-modem pair)
    --stdout              print the lines (pipe them anywhere, or just look)
    --can vcan0           CAN frames on a SocketCAN interface (sudo ip link add dev vcan0 type
                          vcan && sudo ip link set vcan0 up); also can0, or INTERFACE:CHANNEL
                          for other python-can interfaces (pcan:PCAN_USBBUS1, slcan:/dev/ttyACM0)
    --can virtual         python-can's in-process virtual bus (tests and embedding only)

What it sends (``--pattern``), for pressure channels (taps and ``pitot_dp``)::

    steady   constant airspeed --speed (default 0 m/s: still air, as for tools/calibrate_taps.py)
    sweep    airspeed ramps 0 -> --vmax -> 0 every --period seconds
    blow     still air; press Enter (or --blow-every S) to "blow into the tube": a breath of
             --blow-pa that builds up and fades like a real one
    drive    a lap-like speed trace (accelerate, brake, corner) -> q(t) = 1/2 rho v^2 with rho
             from the ambient channels, and every tap = Cp x q with a fixed, physically
             sensible Cp per tap (suction peak near the leading edge, pressure side positive,
             undertray throat); taps lag q through their tubing (first order, catalogue lag_s)

Ambient channels (``amb_temp``, ``amb_press``, ``amb_rh``) read a steady day with tiny noise;
any other catalogue channel reads the middle of its range (``sweep``/``drive`` move it).
``--offset fw_p03=3.4`` adds a sensor zero offset (what calibrate_taps.py removes) and
``--fail-at T`` makes the sensors drop out for ``--fail-for`` seconds (nan + ``$AVS error``,
then ``$AVS ok``), to try the dashboard's stale-sensor handling.

Default channels: ``fw_p03,amb_temp,amb_press,amb_rh`` - the BENCH_ONE_TAP firmware profile.
"""

from __future__ import annotations

import argparse
import math
import os
import random
import shlex
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Protocol

import yaml

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from aerovolt.core import physics  # noqa: E402
from aerovolt.core.catalog import Catalog  # noqa: E402
from aerovolt.core.model import ChannelDef  # noqa: E402
from aerovolt.sources.protocol import format_data, format_hello, format_status  # noqa: E402

FW_VERSION = "fake-1.0"
DEFAULT_CHANNELS = ("fw_p03", "amb_temp", "amb_press", "amb_rh")
HELLO_PERIOD_S = 5.0
PATTERNS = ("steady", "sweep", "blow", "drive")

#: The steady day of the ambient channels (ISA-ish sea level, a typical UK humidity).
AMBIENT = {"amb_temp": 18.0, "amb_press": 101325.0, "amb_rh": 60.0}

# ------------------------------------------------------------------------------------------
# Fixed pressure coefficients per tap
# ------------------------------------------------------------------------------------------
# Cp = (p - p_inf) / q. Piecewise-linear in chord fraction x/c, typical of an inverted
# multi-element wing in ground effect: strong suction near the leading edge of the lower
# (suction) surface recovering towards the trailing edge, mildly positive pressure side;
# the undertray accelerates the flow to a minimum at the throat (~40 % of the floor) and
# the diffuser recovers it. The front wing (ground effect) works harder than the rear one.
CP_CURVES: dict[tuple[str, str], tuple[tuple[float, ...], tuple[float, ...]]] = {
    ("fw", "suction"): ((0.0, 0.05, 0.20, 0.45, 0.75, 1.0), (-1.0, -3.2, -2.6, -1.6, -0.8, -0.3)),
    ("fw", "pressure"): ((0.0, 0.10, 0.50, 1.0), (1.0, 0.8, 0.35, 0.1)),
    ("rw", "suction"): ((0.0, 0.05, 0.20, 0.45, 0.75, 1.0), (-0.8, -2.8, -2.2, -1.4, -0.7, -0.3)),
    ("rw", "pressure"): ((0.0, 0.10, 0.50, 1.0), (1.0, 0.7, 0.3, 0.1)),
    ("ut", "floor"): ((0.0, 0.05, 0.20, 0.40, 0.60, 0.80, 0.97, 1.0), (0.0, -0.4, -1.2, -2.2, -1.5, -0.8, -0.2, -0.1)),
}


def interp(x: float, xs: tuple[float, ...], ys: tuple[float, ...]) -> float:
    """Piecewise-linear interpolation, clamped at the ends."""
    if x <= xs[0]:
        return ys[0]
    for (x0, y0), (x1, y1) in zip(zip(xs, ys), zip(xs[1:], ys[1:])):
        if x <= x1:
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0)
    return ys[-1]


def tap_cp(ch: ChannelDef) -> float:
    """Fixed Cp of a pressure tap from its catalogue geometry; 1.0 for the pitot (Cp of q)."""
    if ch.id == "pitot_dp":
        return 1.0
    meta = ch.meta or {}
    curve = CP_CURVES.get((str(meta.get("element")), str(meta.get("surface"))))
    if curve is None:
        raise ValueError(f"{ch.id}: no Cp curve for element/surface {meta.get('element')}/{meta.get('surface')}")
    cp = interp(float(meta.get("x_c", 0.5)), *curve)
    if meta.get("element") == "ut" and meta.get("station") in ("L", "R"):
        cp -= 0.1  # the diffuser tunnels run a little faster than the centreline
    return cp


def is_pressure(ch: ChannelDef) -> bool:
    return ch.is_tap or ch.id == "pitot_dp"


# ------------------------------------------------------------------------------------------
# Speed traces
# ------------------------------------------------------------------------------------------
#: A Formula Student style lap as (target speed m/s, seconds at it): a launch, a straight,
#: hard braking into a hairpin, a slalom-ish middle sector, a sweeper and a short straight.
DRIVE_SEGMENTS: tuple[tuple[float, float], ...] = (
    (24.0, 2.0), (9.0, 1.5), (17.0, 1.0), (12.0, 1.2), (18.0, 0.8), (13.0, 1.0),
    (27.0, 2.5), (11.0, 1.8), (20.0, 2.0), (15.0, 1.4),
)
ACCEL_MS2 = 6.0   # traction / power limited (80 kW, 300 kg)
BRAKE_MS2 = 13.0  # ~1.3 g with downforce


def drive_speed_trace(dt: float = 0.01) -> tuple[list[float], list[float]]:
    """Time and speed samples of one lap, built from DRIVE_SEGMENTS with finite
    acceleration and braking (so q(t) never jumps). The lap starts and ends at the same
    speed, so it repeats seamlessly."""
    t, v = [0.0], [DRIVE_SEGMENTS[-1][0]]
    for target, hold in DRIVE_SEGMENTS:
        while abs(v[-1] - target) > 1e-9:  # ramp to the target speed
            step = (ACCEL_MS2 if target > v[-1] else -BRAKE_MS2) * dt
            nxt = v[-1] + step
            v.append(min(nxt, target) if step > 0 else max(nxt, target))
            t.append(t[-1] + dt)
        n = max(1, int(round(hold / dt)))
        for _ in range(n):
            v.append(target)
            t.append(t[-1] + dt)
    return t, v


@dataclass
class Pattern:
    """Airspeed (and blow pressure) as a function of time for one --pattern."""

    name: str = "steady"
    speed: float = 0.0        # steady
    vmax: float = 30.0        # sweep
    period: float = 20.0      # sweep
    blow_pa: float = 300.0    # blow
    blow_every: float | None = None
    blows: list[float] = field(default_factory=list)  # blow start times (session s)
    _trace: tuple[list[float], list[float]] | None = None

    def __post_init__(self) -> None:
        if self.name not in PATTERNS:
            raise ValueError(f"unknown pattern {self.name!r} (choose from {', '.join(PATTERNS)})")
        if self.name == "drive":
            self._trace = drive_speed_trace()

    @property
    def lap_time(self) -> float:
        return self._trace[0][-1] if self._trace else 0.0

    def airspeed(self, t: float) -> float:
        """Airspeed in m/s at session time t."""
        if self.name == "steady":
            return self.speed
        if self.name == "sweep":
            phase = (t % self.period) / self.period
            return self.vmax * (2 * phase if phase < 0.5 else 2 * (1 - phase))
        if self.name == "drive":
            ts, vs = self._trace
            return _interp_list(t % ts[-1], ts, vs)
        return 0.0

    def blow(self, t: float) -> float:
        """Breath pressure (Pa) on the sensor port at time t: ramps up with a 0.15 s time
        constant, is held for 1.2 s, then fades with 0.35 s (lungs are not a step input)."""
        if self.name != "blow":
            return 0.0
        starts = list(self.blows)
        if self.blow_every:
            starts.append(math.floor(t / self.blow_every) * self.blow_every)
        total = 0.0
        for t0 in starts:
            age = t - t0
            if age < 0:
                continue
            hold = 1.2
            if age <= hold:
                total = max(total, 1.0 - math.exp(-age / 0.15))
            else:
                total = max(total, (1.0 - math.exp(-hold / 0.15)) * math.exp(-(age - hold) / 0.35))
        return self.blow_pa * total


def _interp_list(x: float, xs: list[float], ys: list[float]) -> float:
    """Linear interpolation on a uniformly sampled trace (O(1))."""
    dt = xs[1] - xs[0]
    i = min(int(x / dt), len(xs) - 2)
    f = (x - xs[i]) / dt
    return ys[i] + (ys[i + 1] - ys[i]) * f


# ------------------------------------------------------------------------------------------
# The node
# ------------------------------------------------------------------------------------------


@dataclass
class ChannelSim:
    """State of one emulated channel."""

    ch: ChannelDef
    period: float              # seconds between samples
    decimals: int              # $AV digits after the point (catalogue resolution)
    cp: float | None = None    # pressure channels
    lagged: float | None = None
    next_t: float = 0.0


def decimals_for(resolution: float) -> int:
    """Digits after the decimal point that show a quantity of this resolution (0.1 -> 1)."""
    if not resolution or resolution >= 1:
        return 0
    return min(6, max(0, math.ceil(-math.log10(resolution) - 1e-9)))


class FakeNode:
    """Produces the lines / values a real sensor node would. Time-driven and deterministic
    (``seed``), so tests can call :meth:`step` with any time sequence."""

    def __init__(self, catalog: Catalog, channels: Iterable[str] = DEFAULT_CHANNELS, *,
                 pattern: Pattern | None = None, node: str = "FAKE", rate_hz: float = 50.0,
                 noise_pa: float = 0.2, offsets: dict[str, float] | None = None, seed: int = 1,
                 fail_at: float | None = None, fail_for: float = 3.0) -> None:
        self.catalog = catalog
        self.pattern = pattern or Pattern()
        self.node = node
        self.rate_hz = rate_hz
        self.noise_pa = noise_pa
        self.offsets = dict(offsets or {})
        self.rng = random.Random(seed)
        self.fail_at, self.fail_for = fail_at, fail_for
        self.channels: list[ChannelSim] = []
        for cid in channels:
            if cid not in catalog:
                raise ValueError(f"unknown channel {cid!r} (not in config/sensors.yaml)")
            ch = catalog[cid]
            if ch.derived or ch.is_truth:
                raise ValueError(f"{cid} is a computed channel; a sensor node sends raw channels only")
            period = 1.0 / min(float(ch.rate_hz or rate_hz), rate_hz)
            sim = ChannelSim(ch, period, decimals_for(float(ch.resolution or 0)))
            if is_pressure(ch):
                sim.cp = tap_cp(ch)
            self.channels.append(sim)
        self.decimals = {c.ch.id: c.decimals for c in self.channels}
        unknown_offsets = set(self.offsets) - {c.ch.id for c in self.channels}
        if unknown_offsets:
            raise ValueError(f"--offset for channel(s) the node does not send: {sorted(unknown_offsets)}")
        self._last_t: float | None = None
        self._next_hello = 0.0
        self._failed = False
        self._booted = False

    @property
    def channel_ids(self) -> list[str]:
        return [c.ch.id for c in self.channels]

    # ---------------------------------------------------------------- physics

    def ambient(self) -> dict[str, float]:
        return dict(AMBIENT)

    def rho(self) -> float:
        """Moist-air density from the node's ambient day (physics.moist_air_density)."""
        a = self.ambient()
        return float(physics.moist_air_density(a["amb_temp"], a["amb_press"], a["amb_rh"]))

    def q(self, t: float) -> float:
        """Dynamic pressure q = 1/2 rho v^2 of the pattern's airspeed, Pa."""
        return float(physics.dynamic_pressure(self.rho(), self.pattern.airspeed(t)))

    def true_value(self, sim: ChannelSim, t: float) -> float:
        """Noise-free value of a channel (before tubing lag and sensor offset)."""
        ch = sim.ch
        if sim.cp is not None:
            return sim.cp * self.q(t) + self.pattern.blow(t)
        if ch.id in AMBIENT:
            return AMBIENT[ch.id]
        lo, hi = float(ch.min), float(ch.max)
        mid = 0.0 if lo < 0 < hi else 0.5 * (lo + hi)
        if self.pattern.name == "sweep":
            return mid + 0.25 * (hi - lo) * math.sin(2 * math.pi * t / self.pattern.period)
        if self.pattern.name == "drive":
            return mid + 0.25 * (hi - lo) * (self.pattern.airspeed(t) / 30.0 - 0.5)
        return mid

    def sample(self, sim: ChannelSim, t: float, dt: float) -> float:
        """What the sensor reads: true value through the tube lag, + offset + noise."""
        value = self.true_value(sim, t)
        lag = float(sim.ch.lag_s or 0.0)
        if lag > 0 and sim.lagged is not None and dt > 0:
            value = sim.lagged + (value - sim.lagged) * (1.0 - math.exp(-dt / lag))
        sim.lagged = value
        sigma = self.noise_pa if sim.cp is not None else float(sim.ch.noise or 0.0)
        return value + self.offsets.get(sim.ch.id, 0.0) + (self.rng.gauss(0.0, sigma) if sigma > 0 else 0.0)

    # ---------------------------------------------------------------- output

    def failing(self, t: float) -> bool:
        return self.fail_at is not None and self.fail_at <= t < self.fail_at + self.fail_for

    def step(self, t: float) -> tuple[list[str], dict[str, float]]:
        """Advance to session time ``t`` (s): returns the protocol lines to send now and the
        values sampled now (``{channel: value}``, NaN while failing)."""
        lines: list[str] = []
        ms = int(round(t * 1000)) % 2**32
        if not self._booted:
            self._booted = True
            lines.append(format_hello(self.node, FW_VERSION, self.channel_ids))
            lines.append(format_status(self.node, ms, "ok", f"boot: fake node, pattern {self.pattern.name}"))
            self._next_hello = t + HELLO_PERIOD_S
        elif t >= self._next_hello:
            self._next_hello += HELLO_PERIOD_S
            lines.append(format_hello(self.node, FW_VERSION, self.channel_ids))
        failing = self.failing(t)
        if failing and not self._failed:
            lines.append(format_status(self.node, ms, "error", f"{self.channel_ids[0]}: sensor not answering (simulated)"))
        elif self._failed and not failing:
            lines.append(format_status(self.node, ms, "ok", f"{self.channel_ids[0]}: recovered"))
        self._failed = failing
        dt = 0.0 if self._last_t is None else t - self._last_t
        self._last_t = t
        values: dict[str, float] = {}
        for sim in self.channels:
            if t + 1e-9 < sim.next_t:
                continue
            sim.next_t = max(sim.next_t + sim.period, t)  # no catch-up bursts after a stall
            values[sim.ch.id] = float("nan") if failing else self.sample(sim, t, dt)
        if values:
            printed = {k: v if math.isnan(v) else round(v, self.decimals[k]) for k, v in values.items()}
            lines.append(format_data(self.node, ms, printed))
        return lines, values


# ------------------------------------------------------------------------------------------
# Transports
# ------------------------------------------------------------------------------------------


class LineSink(Protocol):
    def write_line(self, line: str) -> None: ...
    def close(self) -> None: ...


class StdoutSink:
    def write_line(self, line: str) -> None:
        sys.stdout.write(line.replace("\r\n", "\n"))
        sys.stdout.flush()

    def close(self) -> None:
        pass


class PtySink:
    """A pseudo-terminal: AeroVolt (pyserial) opens ``path`` like a real USB serial port.

    The master side is non-blocking; when nobody reads the slave side, lines are dropped
    (like a node printing into an unplugged cable) instead of blocking the emulator.
    """

    def __init__(self) -> None:
        import tty

        self.master, self.slave = os.openpty()
        tty.setraw(self.slave)  # no echo, no CR/LF translation: a clean byte pipe
        os.set_blocking(self.master, False)
        self.path = os.ttyname(self.slave)
        self.dropped = 0

    def write_line(self, line: str) -> None:
        try:
            os.write(self.master, line.encode("ascii"))
        except (BlockingIOError, OSError):
            self.dropped += 1

    def close(self) -> None:
        for fd in (self.master, self.slave):
            try:
                os.close(fd)
            except OSError:
                pass


class SerialPortSink:
    """An existing serial port (pyserial)."""

    def __init__(self, port: str, baud: int) -> None:
        import serial  # pyserial (requirements-hw.txt)

        self.port = serial.Serial(port, baud, timeout=0, write_timeout=0.5)

    def write_line(self, line: str) -> None:
        self.port.write(line.encode("ascii"))

    def close(self) -> None:
        self.port.close()


def parse_can_spec(spec: str) -> tuple[str, str]:
    """``virtual`` -> (virtual, aerovolt); ``vcan0``/``can0`` -> (socketcan, name);
    ``INTERFACE:CHANNEL`` -> as given."""
    if spec == "virtual":
        return "virtual", "aerovolt"
    if ":" in spec:
        interface, channel = spec.split(":", 1)
        return interface, channel
    return "socketcan", spec


class CanSender:
    """Sends the node's channels as DBC frames, each at its cycle time (GenMsgCycleTime);
    signals the node does not own are SNA (``CanMap.encode``)."""

    def __init__(self, channels: Iterable[str], interface: str, channel: str, bitrate: int = 1_000_000,
                 dbc: Path = ROOT / "can" / "aerovolt.dbc", bus: Any = None) -> None:
        from aerovolt.sources.canmap import CanMap

        self.map = CanMap.from_dbc(dbc)
        owned = [c for c in channels if c in self.map.by_signal]
        self.skipped = [c for c in channels if c not in self.map.by_signal]
        self.frames = self.map.frames_for(owned)
        if bus is None:
            import can

            bus = can.Bus(interface=interface, channel=channel, bitrate=bitrate)
        self.bus = bus
        self.values: dict[str, float] = {}
        self.next_t = {f.id: 0.0 for f in self.frames}
        self.sent = 0

    def update(self, values: dict[str, float]) -> None:
        self.values.update(values)

    def poll(self, t: float) -> None:
        import can

        for frame in self.frames:
            if t + 1e-9 < self.next_t[frame.id]:
                continue
            cycle = (frame.message.cycle_time or 100) / 1000.0
            self.next_t[frame.id] = max(self.next_t[frame.id] + cycle, t)
            data = self.map.encode(frame.id, self.values)
            self.bus.send(can.Message(arbitration_id=frame.id, data=data, is_extended_id=False))
            self.sent += 1

    def close(self) -> None:
        self.bus.shutdown()


# ------------------------------------------------------------------------------------------
# Running
# ------------------------------------------------------------------------------------------


def session_clock() -> Callable[[], float]:
    """Seconds since now (monotonic): the node's session time."""
    start = time.monotonic()
    return lambda: time.monotonic() - start


def run(node: FakeNode, sink: LineSink | None = None, can_sender: CanSender | None = None,
        duration: float | None = None, stop: threading.Event | None = None,
        clock: Callable[[], float] | None = None) -> None:
    """Run the node in real time until ``duration`` elapses or ``stop`` is set.
    ``clock()`` gives session time in seconds (default: from the call of run())."""
    clock = clock or session_clock()
    tick = 1.0 / node.rate_hz
    next_tick = clock()
    while not (stop is not None and stop.is_set()):
        t = clock()
        if duration is not None and t >= duration:
            break
        lines, values = node.step(t)
        if sink is not None:
            for line in lines:
                sink.write_line(line)
        if can_sender is not None:
            can_sender.update(values)
            can_sender.poll(t)
        next_tick += tick
        delay = next_tick - clock()
        if delay > 0:
            time.sleep(delay)
        else:
            next_tick = clock()


def write_hybrid_config(port: str, channels: list[str], out: Path,
                        base: Path = ROOT / "config" / "hybrid_serial.yaml") -> Path:
    """A copy of the hybrid (sim + serial node) config whose serial source uses ``port``."""
    data: dict[str, Any] = yaml.safe_load(base.read_text(encoding="utf-8")) if base.exists() else {}
    data = data or {}
    sources = data.get("sources") or [{"type": "sim", "label": "Simulator"}]
    serial = next((s for s in sources if s.get("type") == "serial"), None)
    if serial is None:
        serial = {"type": "serial", "label": "Fake sensor node", "baud": 115200}
        sources.append(serial)
    serial["port"] = port
    serial["channels"] = list(channels)
    serial["label"] = f"Fake sensor node on {port}"
    data["sources"] = sources
    data.setdefault("session", {})["name"] = "Bench demo with tools/fake_sensor_node.py"
    out.write_text("# Generated by tools/fake_sensor_node.py --pty from " + base.name + "\n"
                   + yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
    return out


def start_enter_listener(pattern: Pattern, clock_t: Callable[[], float], stop: threading.Event) -> None:
    """Each Enter on stdin triggers a blow (pattern 'blow')."""

    def listen() -> None:
        for _ in sys.stdin:
            if stop.is_set():
                return
            pattern.blows.append(clock_t())
            print("  blow!", file=sys.stderr, flush=True)

    threading.Thread(target=listen, name="enter-listener", daemon=True).start()


def parse_offsets(items: list[str]) -> dict[str, float]:
    out: dict[str, float] = {}
    for item in items:
        name, eq, value = item.partition("=")
        if not eq:
            raise argparse.ArgumentTypeError(f"--offset expects CHANNEL=PA, got {item!r}")
        out[name.strip()] = float(value)
    return out


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                formatter_class=argparse.RawDescriptionHelpFormatter,
                                epilog="Example: python tools/fake_sensor_node.py --pty --pattern blow")
    out = p.add_mutually_exclusive_group(required=True)
    out.add_argument("--pty", action="store_true", help="create a pseudo-terminal and print its path + the AeroVolt command")
    out.add_argument("--port", help="write to an existing serial port, e.g. /dev/ttyUSB1 or COM7")
    out.add_argument("--stdout", action="store_true", help="print the lines")
    out.add_argument("--can", metavar="SPEC", help="send CAN frames: vcan0 | can0 | virtual | INTERFACE:CHANNEL")
    p.add_argument("--pattern", choices=PATTERNS, help="default: blow with --pty, steady otherwise")
    p.add_argument("--channels", default=",".join(DEFAULT_CHANNELS), help="comma-separated channel ids")
    p.add_argument("--node", default="FAKE", help="node name in the $AV lines")
    p.add_argument("--rate", type=float, default=50.0, help="max sample / line rate, Hz (default 50)")
    p.add_argument("--baud", type=int, default=115200)
    p.add_argument("--bitrate", type=int, default=1_000_000)
    p.add_argument("--speed", type=float, default=0.0, help="steady: airspeed, m/s (default 0 = still air)")
    p.add_argument("--vmax", type=float, default=30.0, help="sweep: top airspeed, m/s")
    p.add_argument("--period", type=float, default=20.0, help="sweep: seconds per up-and-down")
    p.add_argument("--blow-pa", type=float, default=300.0, help="blow: breath pressure, Pa (negative = suck)")
    p.add_argument("--blow-every", type=float, help="blow: blow automatically every S seconds")
    p.add_argument("--noise", type=float, default=0.2, help="pressure sensor noise (1 sigma), Pa")
    p.add_argument("--offset", action="append", default=[], metavar="CH=PA", help="sensor zero offset, e.g. fw_p03=3.4")
    p.add_argument("--fail-at", type=float, help="sensors drop out at this time (s)")
    p.add_argument("--fail-for", type=float, default=3.0, help="... for this long (s)")
    p.add_argument("--duration", type=float, help="stop after this many seconds")
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--config-out", type=Path, help="--pty: where to write the ready-to-run AeroVolt config")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    args.pattern = args.pattern or ("blow" if args.pty else "steady")
    catalog = Catalog.load(ROOT / "config" / "sensors.yaml")
    channels = [c.strip() for c in args.channels.split(",") if c.strip()]
    pattern = Pattern(args.pattern, speed=args.speed, vmax=args.vmax, period=args.period,
                      blow_pa=args.blow_pa, blow_every=args.blow_every)
    try:
        node = FakeNode(catalog, channels, pattern=pattern, node=args.node, rate_hz=args.rate, noise_pa=args.noise,
                        offsets=parse_offsets(args.offset), seed=args.seed, fail_at=args.fail_at, fail_for=args.fail_for)
    except (ValueError, argparse.ArgumentTypeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    sink: LineSink | None = None
    can_sender: CanSender | None = None
    stop = threading.Event()
    clock = session_clock()
    try:
        if args.pty:
            pty_sink = PtySink()
            sink = pty_sink
            name = Path(pty_sink.path).name
            cfg = args.config_out or Path(tempfile.gettempdir()) / f"aerovolt_fake_node_{name}.yaml"
            write_hybrid_config(pty_sink.path, node.channel_ids, cfg)
            print(f"Fake sensor node '{args.node}' on {pty_sink.path}  "
                  f"(pattern {args.pattern}, channels {', '.join(node.channel_ids)})")
            print("Start AeroVolt with it (simulator + this node = the Phase-2 bench demo):")
            print(f"    cd {shlex.quote(str(ROOT))} && {shlex.quote(sys.executable)} -m aerovolt "
                  f"--config {shlex.quote(str(cfg))} --open")
            print(f"(or put  port: {pty_sink.path}  in config/hybrid_serial.yaml)")
        elif args.port:
            sink = SerialPortSink(args.port, args.baud)
            print(f"Fake sensor node '{args.node}' writing to {args.port} @ {args.baud} baud", file=sys.stderr)
        elif args.stdout:
            sink = StdoutSink()
        else:
            interface, channel = parse_can_spec(args.can)
            try:
                can_sender = CanSender(node.channel_ids, interface, channel, args.bitrate)
            except Exception as exc:  # noqa: BLE001 - python-can raises OSError or CanInitializationError
                hint = (f"\n  create it with: sudo ip link add dev {channel} type vcan && sudo ip link set {channel} up"
                        if interface == "socketcan" and channel.startswith("vcan") else "")
                print(f"error: cannot open CAN {interface}:{channel}: {exc}{hint}", file=sys.stderr)
                return 1
            if can_sender.skipped:
                print(f"note: not CAN signals, not sent: {', '.join(can_sender.skipped)}", file=sys.stderr)
            print(f"Fake sensor node sending {len(can_sender.frames)} frame type(s) on {interface}:{channel}"
                  + (" (in-process bus: only this program can see it)" if interface == "virtual" else ""),
                  file=sys.stderr)
        if args.pattern == "blow" and args.blow_every is None:
            print("Press Enter to blow on the sensor, Ctrl+C to stop.", file=sys.stderr)
            start_enter_listener(pattern, clock, stop)
        sys.stdout.flush()
        run(node, sink, can_sender, duration=args.duration, stop=stop, clock=clock)
    except KeyboardInterrupt:
        pass
    except OSError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    finally:
        stop.set()
        if sink is not None:
            sink.close()
        if can_sender is not None:
            can_sender.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
