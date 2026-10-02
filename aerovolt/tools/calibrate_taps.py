#!/usr/bin/env python3
"""Zero-offset calibration of the pressure taps and the pitot (SPEC section 12).

A differential-pressure sensor with no airflow should read 0 Pa. In practice it reads a
small offset - the sensor's own zero error (Sensirion SDP: ~0.1 Pa; cheap analog sensors:
tens of Pa), a few pascals of hydrostatic head if the tubes are not level, or the effect of
temperature on the electronics. This tool measures that offset so AeroVolt can remove it:

1. read the live sensors for ``--seconds`` (default 10) through the same source classes
   AeroVolt uses (``SerialSource`` / ``CanSource``), so the values are exactly the raw
   values the dashboard would receive;
2. per channel (default: every pressure tap and ``pitot_dp`` that sends data) compute the
   mean and the standard deviation;
3. **refuse** if any channel fluctuates more than ``--max-std`` (default 2 Pa): that means
   air is moving (wind, a fan, someone walking past the car, the engine-bay cooling fan) and
   the mean would not be the zero;
4. write the means as offsets into ``config/calibration.yaml``, merged with what is there:
   AeroVolt then applies ``value = (raw - offset) * scale`` to the real sensors. Existing
   entries of other channels are kept, and so is an existing ``scale`` (a gain calibration
   does not change when the zero is re-measured); new entries get ``scale: 1.0``.

Do it with the car stationary, the pitot covered (tape or a cap, so wind cannot blow into
it), all tubes connected, and the sensors warmed up for a few minutes. Examples::

    python tools/calibrate_taps.py --port /dev/ttyACM0          # a USB sensor node
    python tools/calibrate_taps.py --port auto --seconds 20
    python tools/calibrate_taps.py --can can0                    # the car's CAN bus
    python tools/calibrate_taps.py --config config/hybrid_serial.yaml   # the node of a config
    python tools/calibrate_taps.py --port /dev/pts/5 --dry-run   # with tools/fake_sensor_node.py --pty
"""

from __future__ import annotations

import argparse
import asyncio
import math
import os
import statistics
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from aerovolt.core.config import AppConfig, ConfigError, load_config  # noqa: E402
from aerovolt.core.source import SessionContext, SourceError, create_source  # noqa: E402

DEFAULT_SECONDS = 10.0
DEFAULT_MAX_STD_PA = 2.0
#: An offset this large is suspicious for an SDP sensor (leak, tube head, wind on the pitot).
WARN_OFFSET_PA = 20.0
#: Seconds to wait for the first sample (``port: auto`` probes each port for up to 6 s).
DEFAULT_WAIT_S = 15.0
MIN_SAMPLES = 5

EXIT_OK, EXIT_ERROR, EXIT_NO_DATA, EXIT_AIRFLOW = 0, 1, 2, 3


@dataclass
class ChannelStats:
    """Statistics of one channel over the averaging window."""

    channel: str
    n: int
    nan: int
    mean: float
    std: float
    lo: float
    hi: float

    @classmethod
    def of(cls, channel: str, samples: list[float]) -> ChannelStats:
        good = [v for v in samples if not math.isnan(v)]
        if not good:
            return cls(channel, 0, len(samples), math.nan, math.nan, math.nan, math.nan)
        std = statistics.stdev(good) if len(good) > 1 else 0.0
        return cls(channel, len(good), len(samples) - len(good), statistics.fmean(good), std, min(good), max(good))


# ------------------------------------------------------------------------------------------
# Reading the sensors
# ------------------------------------------------------------------------------------------


def parse_can_spec(spec: str) -> tuple[str, str]:
    """``virtual`` -> (virtual, aerovolt); ``vcan0``/``can0`` -> (socketcan, name);
    ``INTERFACE:CHANNEL`` -> as given (same convention as tools/fake_sensor_node.py)."""
    if spec == "virtual":
        return "virtual", "aerovolt"
    if ":" in spec:
        interface, channel = spec.split(":", 1)
        return interface, channel
    return "socketcan", spec


def source_configs(args: argparse.Namespace, app: AppConfig) -> list[dict[str, Any]]:
    """The hardware source(s) to read, as SPEC source config dicts."""
    if args.port:
        return [{"type": "serial", "label": "calibration", "port": args.port, "baud": args.baud}]
    if args.can:
        interface, channel = parse_can_spec(args.can)
        return [{"type": "can", "label": "calibration", "interface": interface, "channel": channel,
                 "bitrate": args.bitrate, "dbc": "can/aerovolt.dbc"}]
    hardware = [dict(s) for s in app.sources if s.get("type") in ("serial", "can")]
    if not hardware:
        raise ConfigError(f"{args.config}: no serial or CAN source to calibrate")
    for cfg in hardware:
        cfg.pop("channels", None)  # calibrate whatever the node sends
    return hardware


async def collect(app: AppConfig, configs: list[dict[str, Any]], seconds: float, wait_s: float,
                  progress: bool = True) -> tuple[dict[str, list[float]], list[str]]:
    """Run the sources; from the first sample on, record ``seconds`` of every channel.

    Returns ``({channel: [values]}, [source detail texts])``.
    """
    ctx = SessionContext(config=app, catalog=app.catalog, vehicle=app.vehicle, root=app.root)
    sources = [create_source(cfg, ctx) for cfg in configs]
    samples: dict[str, list[float]] = {}
    loop = asyncio.get_running_loop()
    first = loop.create_future()

    def emit(t: float, values: dict[str, float]) -> None:
        if not first.done():
            first.set_result(loop.time())
        for cid, v in values.items():
            samples.setdefault(cid, []).append(float(v))

    tasks = [asyncio.create_task(src.run(emit), name=f"calibrate-{src.kind}") for src in sources]
    try:
        try:
            await asyncio.wait_for(asyncio.shield(first), wait_s)
        except asyncio.TimeoutError:
            return {}, [f"{s.kind}: {s.status} - {s.detail}" for s in sources]
        samples.clear()  # start the window cleanly at the first sample
        if progress:
            print(f"receiving data - averaging for {seconds:g} s, keep the air still ...", file=sys.stderr)
        await asyncio.sleep(seconds)
        return samples, [f"{s.kind}: {s.detail}" for s in sources]
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


def default_channels(app: AppConfig, seen: set[str]) -> list[str]:
    """Every pressure tap and the pitot that delivered data, in catalogue order."""
    wanted = [c.id for c in app.catalog.taps()] + ["pitot_dp"]
    return [c for c in wanted if c in seen]


# ------------------------------------------------------------------------------------------
# calibration.yaml
# ------------------------------------------------------------------------------------------


def _header(text: str) -> str:
    """The leading comment block of the existing file (kept when rewriting it)."""
    lines = []
    for line in text.splitlines():
        if line.startswith("#") or not line.strip():
            lines.append(line)
        else:
            break
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines) + "\n" if lines else ""


def _flow(entry: dict[str, Any]) -> str:
    return yaml.safe_dump(entry, default_flow_style=True, sort_keys=False, width=1000).strip()


def merge_calibration(path: Path, stats: list[ChannelStats], seconds: float, source: str) -> dict[str, Any]:
    """Merge the measured offsets into ``path`` (atomically) and return the new mapping."""
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    data = yaml.safe_load(text) if text.strip() else {}
    data = dict(data or {})
    date = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    for st in stats:
        old = data.get(st.channel) or {}
        data[st.channel] = {
            "offset": round(st.mean, 3),
            "scale": float(old.get("scale", 1.0)),
            "std": round(st.std, 3),
            "samples": st.n,
            "date": date,
            "note": f"zero offset, {seconds:g} s average, {source}",
        }
    header = _header(text) or "# Calibration of REAL sensors: value = (raw - offset) * scale (see tools/calibrate_taps.py)\n"
    body = "\n".join(f"{cid}: {_flow(entry)}" for cid, entry in data.items()) if data else "{}"
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(header + body + "\n", encoding="utf-8")
    os.replace(tmp, path)
    return data


# ------------------------------------------------------------------------------------------
# Command line
# ------------------------------------------------------------------------------------------


def print_table(stats: list[ChannelStats], max_std: float) -> None:
    print(f"{'channel':<10} {'samples':>7} {'mean Pa':>9} {'std Pa':>7} {'min Pa':>8} {'max Pa':>8}  verdict")
    for st in stats:
        if st.n < MIN_SAMPLES:
            verdict = "NO DATA"
        elif st.std > max_std:
            verdict = "AIRFLOW?"
        elif abs(st.mean) > WARN_OFFSET_PA:
            verdict = "ok (large offset!)"
        else:
            verdict = "ok"
        print(f"{st.channel:<10} {st.n:>7} {st.mean:>9.3f} {st.std:>7.3f} {st.lo:>8.2f} {st.hi:>8.2f}  {verdict}")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--port", help="serial sensor node: /dev/ttyACM0, COM5, auto, or a fake node's /dev/pts/N")
    src.add_argument("--can", metavar="SPEC", help="CAN bus: can0 | vcan0 | virtual | INTERFACE:CHANNEL")
    src.add_argument("--config", type=Path, help="use the serial/CAN source(s) of this AeroVolt config")
    p.add_argument("--baud", type=int, default=115200)
    p.add_argument("--bitrate", type=int, default=1_000_000)
    p.add_argument("--seconds", type=float, default=DEFAULT_SECONDS, help="averaging time (default 10 s)")
    p.add_argument("--channels", help="comma-separated channel ids (default: all taps + pitot_dp seen)")
    p.add_argument("--max-std", type=float, default=DEFAULT_MAX_STD_PA,
                   help="refuse if any channel's standard deviation exceeds this, Pa (default 2)")
    p.add_argument("--wait", type=float, default=DEFAULT_WAIT_S, help="seconds to wait for the first data")
    p.add_argument("--calibration", type=Path, help="file to write (default: the config's calibration.yaml)")
    p.add_argument("--dry-run", action="store_true", help="measure and print, do not write")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        app = load_config(args.config)
        configs = source_configs(args, app)
    except ConfigError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_ERROR
    target = args.calibration or app.paths.calibration
    what = ", ".join(f"{c['type']} {c.get('port') or c.get('channel')}" for c in configs)
    print(f"Zero-offset calibration from {what}: car stationary, pitot covered, no airflow.", file=sys.stderr)
    try:
        samples, details = asyncio.run(collect(app, configs, args.seconds, args.wait))
    except SourceError as exc:  # e.g. pyserial / python-can not installed
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_ERROR
    if not samples:
        print("error: no data received - " + "; ".join(details), file=sys.stderr)
        return EXIT_NO_DATA

    if args.channels:
        channels = [c.strip() for c in args.channels.split(",") if c.strip()]
        unknown = [c for c in channels if c not in app.catalog]
        if unknown:
            print(f"error: unknown channel(s) {unknown}", file=sys.stderr)
            return EXIT_ERROR
    else:
        channels = default_channels(app, set(samples))
        if not channels:
            print(f"error: the source sends no pressure taps or pitot_dp (only {', '.join(sorted(samples))})",
                  file=sys.stderr)
            return EXIT_NO_DATA
    stats = [ChannelStats.of(c, samples.get(c, [])) for c in channels]
    print_table(stats, args.max_std)

    missing = [s.channel for s in stats if s.n < MIN_SAMPLES]
    if missing:
        print(f"error: not enough data from {', '.join(missing)} - nothing written", file=sys.stderr)
        return EXIT_NO_DATA
    moving = [s for s in stats if s.std > args.max_std]
    if moving:
        worst = ", ".join(f"{s.channel} ({s.std:.2f} Pa)" for s in moving)
        print(f"REFUSED: the pressure is not steady on {worst} > {args.max_std:g} Pa.\n"
              "Air is moving (wind, fans, people near the car) or a tube is loose: cover the pitot,\n"
              "close doors, wait and run again. Nothing was written.", file=sys.stderr)
        return EXIT_AIRFLOW
    for s in stats:
        if abs(s.mean) > WARN_OFFSET_PA:
            print(f"warning: {s.channel} offset {s.mean:.1f} Pa is large for an SDP sensor - "
                  "check for wind on the pitot, a leaking tube or tubes at different heights", file=sys.stderr)
    if args.dry_run:
        print("dry run: nothing written", file=sys.stderr)
        return EXIT_OK
    merge_calibration(target, stats, args.seconds, what)
    print(f"Wrote {len(stats)} offset(s) to {target}: "
          + ", ".join(f"{s.channel} {s.mean:+.3f} Pa" for s in stats))
    print("AeroVolt applies them to the real sensors at the next start.")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
