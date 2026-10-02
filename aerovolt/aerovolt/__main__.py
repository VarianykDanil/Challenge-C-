"""Command line: ``python -m aerovolt`` (SPEC section 9).

Examples::

    python -m aerovolt                                   # demo: simulator + dashboard on :8080
    python -m aerovolt --open --speed 4                  # 4x real time, open the browser
    python -m aerovolt --fault cell_hot@60 --fault pump_fail@120
    python -m aerovolt --config config/hybrid_serial.yaml   # sim + a real USB sensor node
    python -m aerovolt --config config/car_can.yaml         # the real car over CAN
    python -m aerovolt --headless --duration 300 --speed max --log logs/run1.csv.gz
    python -m aerovolt --list-faults | --list-tracks

Errors that a user can fix (missing hardware packages, a busy port, a bad config file)
are printed as one friendly line instead of a traceback (``-v`` shows details).
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import signal
import sys
import webbrowser
from typing import Any, Sequence

from aerovolt import __version__
from aerovolt.core.config import ConfigError, load_config
from aerovolt.core.source import MissingDependencyError, SourceError

#: Exit status for configuration / environment problems.
EXIT_USAGE = 2


class CliError(Exception):
    """A problem the user can fix; printed without a traceback."""


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m aerovolt",
        description="AeroVolt - telemetry and analysis for a Formula Student electric car "
                    "(aero sensing + EV powertrain). Starts the simulator / sensor sources and the "
                    "web dashboard.")
    p.add_argument("--config", default="config/demo.yaml", help="config file (default: config/demo.yaml)")
    p.add_argument("--host", help="web server address (0.0.0.0 = reachable from other computers)")
    p.add_argument("--port", type=int, help="web server port (default from config: 8080)")
    p.add_argument("--speed", help="simulation / replay speed: a factor such as 1, 4, 0.5 - or 'max'")
    p.add_argument("--track", help="track for the simulator (see --list-tracks)")
    p.add_argument("--fault", action="append", metavar="ID@T", default=[],
                   help="schedule a sim fault at T seconds, e.g. cell_hot@60 (repeatable; see --list-faults)")
    p.add_argument("--log", metavar="PATH", help="write a data log (.csv or .csv.gz), e.g. logs/run1.csv.gz")
    p.add_argument("--open", action="store_true", help="open the dashboard in the web browser")
    p.add_argument("--headless", action="store_true", help="no web server: run, then print a summary")
    p.add_argument("--duration", type=float, metavar="SECONDS", help="headless run length (session time)")
    p.add_argument("--list-faults", action="store_true", help="list the injectable simulator faults and exit")
    p.add_argument("--list-tracks", action="store_true", help="list the built-in tracks and exit")
    p.add_argument("-v", "--verbose", action="store_true", help="more log output (and tracebacks)")
    p.add_argument("--version", action="version", version=f"AeroVolt {__version__}")
    return p


# --------------------------------------------------------------------------------------
# Listings
# --------------------------------------------------------------------------------------


def list_faults() -> str:
    from aerovolt.sim.faults import FAULTS

    rows = [(f.id, f.system, f.title, ", ".join(f.alerts)) for f in FAULTS.values()]
    out = [_table(("fault id", "system", "effect", "expected alerts"), rows),
           "", "Inject at start-up with --fault ID@SECONDS, or live from the dashboard's Faults panel."]
    return "\n".join(out)


def list_tracks() -> str:
    from aerovolt.sim.tracks import TRACKS, get_track

    rows = []
    for name in TRACKS:
        track = get_track(name)
        kinds = sorted({f.kind for f in getattr(track, "features", [])})
        rows.append((name, f"{track.length:.0f} m", "closed loop" if track.closed else "open (run)",
                     ", ".join(kinds) or "-"))
    return _table(("track", "length", "type", "features"), rows)


# --------------------------------------------------------------------------------------
# Output formatting
# --------------------------------------------------------------------------------------


def _table(header: Sequence[str], rows: Sequence[Sequence[Any]]) -> str:
    """Plain-text table with aligned columns."""
    cells = [[str(c) for c in header]] + [["-" if c is None else str(c) for c in row] for row in rows]
    widths = [max(len(r[i]) for r in cells) for i in range(len(header))]
    lines = ["  ".join(c.ljust(w) for c, w in zip(r, widths)).rstrip() for r in cells]
    lines.insert(1, "  ".join("-" * w for w in widths))
    return "\n".join(lines)


def _num(value: Any, fmt: str) -> str:
    return "-" if value is None else format(value, fmt)


def format_summary(summary: dict[str, Any]) -> str:
    """Readable report of a headless run (laps, alerts, faults, final values)."""
    out = [f"AeroVolt headless run - mode {summary['mode']}, track {summary.get('track') or '-'}",
           f"session time {summary['duration_s']:.1f} s in {summary['wall_s']:.1f} s wall clock"
           + (f" ({summary['realtime_factor']:g}x real time)" if summary.get("realtime_factor") else ""),
           ""]
    laps = summary.get("laps") or []
    out.append(f"Laps completed: {len(laps)}")
    if laps:
        out.append(_table(
            ("lap", "time s", "v_avg km/h", "v_max km/h", "energy kWh", "regen kWh", "CL.A m2", "CD.A m2",
             "bal %F", "cell T max", "mot T max"),
            [(lap["lap"], _num(lap.get("lap_time"), ".2f"),
              _num(None if lap.get("v_avg") is None else lap["v_avg"] * 3.6, ".1f"),
              _num(None if lap.get("v_max") is None else lap["v_max"] * 3.6, ".1f"),
              _num(lap.get("energy_kwh"), ".3f"), _num(lap.get("regen_kwh"), ".3f"),
              _num(lap.get("cla_avg"), ".2f"), _num(lap.get("cda_avg"), ".2f"),
              _num(lap.get("balance_avg"), ".1f"), _num(lap.get("cell_t_max"), ".1f"),
              _num(lap.get("mot_temp_max"), ".1f")) for lap in laps]))
    out.append("")
    alerts = summary.get("alerts") or []
    out.append(f"Alerts raised: {len(alerts)}")
    if alerts:
        out.append(_table(("t start", "t end", "severity", "alert", "detail"),
                          [(_num(a.get("t_start"), ".1f"), _num(a.get("t_end"), ".1f") if not a.get("active")
                            else "active", a.get("severity"), a.get("id"), a.get("detail", "")[:70])
                           for a in alerts]))
    faults = summary.get("faults") or []
    if faults:
        out += ["", "Fault timeline:", _table(("t", "fault", "state", "by"),
                                              [(_num(f["t"], ".1f"), f["id"], "ON" if f["active"] else "off",
                                                f.get("by", "")) for f in faults])]
    strategy = summary.get("strategy")
    if strategy:
        out += ["", "Endurance strategy: recommended power limit "
                f"{_num(strategy.get('recommended_kw'), '.0f')} kW, laps needed "
                f"{strategy.get('laps_needed', '-')}, energy/lap {_num(strategy.get('energy_per_lap_kwh'), '.3f')} kWh"]
    sources = summary.get("sources") or []
    if sources:
        out += ["", "Sources:", _table(("kind", "label", "status", "detail"),
                                       [(src.get("kind"), src.get("label"), src.get("status"),
                                         str(src.get("detail", ""))[:160]) for src in sources])]
    final = summary.get("final") or {}
    if final:
        out += ["", "Final values:", _table(("channel", "value"), [(k, v) for k, v in final.items()])]
    if summary.get("log"):
        out += ["", f"Data log: {summary['log']}"]
    return "\n".join(out)


# --------------------------------------------------------------------------------------
# Running
# --------------------------------------------------------------------------------------


def _parse_speed(text: str | None) -> float | str | None:
    if text is None:
        return None
    if text.strip().lower() == "max":
        return "max"
    try:
        value = float(text)
    except ValueError:
        raise CliError(f"--speed must be a number or 'max', not {text!r}") from None
    if value <= 0:
        raise CliError("--speed must be > 0")
    return value


def _check_serial_ports(config: Any) -> list[str]:
    """Warnings for serial sources whose fixed port does not exist (they keep retrying)."""
    warnings = []
    for src in config.sources:
        port = str(src.get("port") or "auto")
        if src["type"] != "serial" or port.lower() == "auto" or port.upper().startswith("COM"):
            continue
        if not os.path.exists(port):
            warnings.append(f"warning: serial port {port} not found - plug in the sensor node; "
                            "AeroVolt keeps retrying every 2 s (or use 'port: auto')")
    return warnings


def make_session(args: argparse.Namespace) -> Any:
    """Load the config (with CLI overrides) and build the session."""
    speed = _parse_speed(args.speed)
    overrides = {"speed": speed, "track": args.track, "host": args.host, "port": args.port,
                 "faults": args.fault or None, "log": args.log, "headless": args.headless or None,
                 "duration": args.duration}
    try:
        config = load_config(args.config, overrides)
    except FileNotFoundError as exc:
        raise CliError(f"config file not found: {exc.filename or args.config}") from None
    except ConfigError as exc:
        raise CliError(f"bad configuration: {exc}") from None
    if speed is not None:
        for src in config.sources:
            if src["type"] == "replay":
                src["speed"] = speed
    for warning in _check_serial_ports(config):
        print(warning, file=sys.stderr)

    from aerovolt.server.session import Session

    try:
        return Session(config)
    except MissingDependencyError as exc:
        raise CliError(str(exc)) from None
    except (SourceError, KeyError) as exc:
        text = str(exc.args[0]) if isinstance(exc, KeyError) and exc.args else str(exc)
        if "replay file not found" in text:
            text += (" - record one first, e.g. python -m aerovolt --headless --duration 600 "
                     "--speed max --log logs/demo.csv.gz")
        raise CliError(f"cannot start the data sources: {text}") from None


def _install_stop_handlers(stop: asyncio.Event) -> None:
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except (NotImplementedError, RuntimeError):  # Windows: Ctrl+C raises KeyboardInterrupt
            pass


async def run_headless(session: Any, duration: float | None) -> dict[str, Any]:
    stop = asyncio.Event()
    _install_stop_handlers(stop)
    task = asyncio.create_task(session.run_headless(duration))
    waiter = asyncio.create_task(stop.wait())
    await asyncio.wait({task, waiter}, return_when=asyncio.FIRST_COMPLETED)
    if not task.done():  # Ctrl+C: stop cleanly and still print what happened
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await session.stop()
        waiter.cancel()
        return session.summary()
    waiter.cancel()
    return task.result()


async def run_server(session: Any, open_browser: bool) -> None:
    from aerovolt.server.app import serve

    host, port = session.config.server.host, session.config.server.port
    stop = asyncio.Event()
    _install_stop_handlers(stop)

    def started(actual_port: int) -> None:
        shown = "127.0.0.1" if host in ("0.0.0.0", "::") else host
        url = f"http://{shown}:{actual_port}/"
        print(f"AeroVolt {__version__} - mode {session.mode} - {len(session.catalog)} channels")
        print(f"dashboard: {url}   (Ctrl+C to stop)")
        if host in ("0.0.0.0", "::"):
            print("listening on all network interfaces: other devices can use this computer's IP address")
        if open_browser:
            webbrowser.open(url)

    await serve(session, host, port, stop_event=stop, on_started=started)


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=logging.INFO if args.verbose else logging.WARNING,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s", datefmt="%H:%M:%S")
    try:
        if args.list_faults or args.list_tracks:
            if args.list_faults:
                print(list_faults())
            if args.list_tracks:
                if args.list_faults:
                    print()
                print(list_tracks())
            return 0
        session = make_session(args)
        if args.headless:
            duration = session.config.duration
            finite = any((s["type"] == "sim" and s.get("laps")) or (s["type"] == "replay" and not s.get("loop"))
                         for s in session.config.sources)
            if duration is None and not finite:
                raise CliError("--headless needs --duration SECONDS (or a sim 'laps' limit in the config)")
            summary = asyncio.run(run_headless(session, duration))
            print(format_summary(summary))
            return 0
        from aerovolt.server.app import PortInUseError

        try:
            asyncio.run(run_server(session, args.open))
        except PortInUseError as exc:
            raise CliError(f"{exc.strerror} - is AeroVolt already running? try --port "
                           f"{session.config.server.port + 1}") from None
        except OSError as exc:
            raise CliError(f"cannot start the web server: {exc}") from None
        return 0
    except CliError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_USAGE
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
