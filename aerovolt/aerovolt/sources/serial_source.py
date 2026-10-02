"""``SerialSource``: a USB-serial sensor node as a data source (``type: serial``, SPEC 7.2).

The node prints the line protocol of :mod:`aerovolt.sources.protocol` (``$AV`` data,
``$AVH`` hello, ``$AVS`` status, or beginner JSON lines). This source:

1. finds the port - a fixed name (``/dev/ttyACM0``, ``COM5``) or ``auto``: the first USB
   serial device that prints a valid AeroVolt line (its ``$AVH`` hello comes at boot and
   every 5 s; opening the port resets most Arduino-style boards, so it arrives quickly),
   otherwise the first ``ttyACM``/``ttyUSB`` device;
2. reads in a background thread (pyserial reads block), splits the byte stream into
   lines, parses them and hands the results to the asyncio event loop with
   ``loop.call_soon_threadsafe`` (``emit`` must run on the loop thread);
3. timestamps every sample on **arrival** with the session clock - the node's own
   millisecond counter is not trusted, so nodes need no clock synchronisation;
4. reconnects every 2 s when the port is missing or disappears (USB cable pulled):
   ``status: waiting`` with an explanation in ``detail`` meanwhile.

Config::

    - type: serial
      label: Bench node
      port: auto                # or /dev/ttyACM0, /dev/ttyUSB0, COM5 ...
      baud: 115200
      channels: [fw_p03]        # optional: only these channels are taken from this node

pyserial is imported lazily (``requirements-hw.txt``) so the sim-only demo does not need it.
"""

from __future__ import annotations

import asyncio
import logging
import re
import threading
import time
from collections import deque
from types import ModuleType
from typing import Any, Callable

from aerovolt.core.model import Emit
from aerovolt.core.source import SessionContext, Source, import_hardware, register_source

from .protocol import ChecksumError, ParsedLine, ProtocolError, parse_line

log = logging.getLogger(__name__)

#: Seconds between reconnection attempts.
RECONNECT_S = 2.0
#: How long ``port: auto`` listens to each candidate port for an AeroVolt line, s.
#: The hello is repeated every 5 s, so 6 s always catches one.
PROBE_S = 6.0
#: Read timeout of the worker thread, s (also bounds how long stopping takes).
READ_TIMEOUT_S = 0.1
#: A "line" longer than this without a newline is garbage (wrong baud rate?), bytes.
MAX_LINE_BYTES = 4096
#: Lines buffered between the reader thread and the event loop before dropping.
QUEUE_MAX = 20_000
#: Device names that are USB-serial adapters / native-USB boards on Linux and macOS.
_USB_NAME_RE = re.compile(r"(ttyACM|ttyUSB|usbmodem|usbserial|wchusbserial|SLAB_USBtoUART)", re.I)
#: Fallback for ``port: auto`` when no port answered: typical Arduino / adapter names.
_FALLBACK_RE = re.compile(r"(ttyACM|ttyUSB)")


class _Disconnected:
    """Sent by the reader thread when the port fails (cable pulled, device reset)."""

    def __init__(self, reason: str) -> None:
        self.reason = reason


def list_candidate_ports() -> list[str]:
    """Serial devices that may be a sensor node: USB devices first, in name order.

    Uses ``serial.tools.list_ports``; a port counts as USB if it reports a USB vendor id
    or has a USB-style device name. Kept as a module function so tests can replace it.
    """
    list_ports = import_hardware("serial.tools.list_ports")
    usb, other = [], []
    for info in list_ports.comports():
        if getattr(info, "vid", None) is not None or _USB_NAME_RE.search(info.device):
            usb.append(info.device)
        else:
            other.append(info.device)
    return sorted(usb) + sorted(other)


def _is_node_line(raw: bytes) -> bool:
    try:
        return parse_line(raw) is not None
    except Exception:  # noqa: BLE001 - probing must never crash
        return False


def probe_port(serial_mod: ModuleType, port: str, baud: int, seconds: float,
               cancel: threading.Event | None = None) -> bool:
    """Open ``port`` and listen up to ``seconds`` for one valid AeroVolt line."""
    try:
        ser = serial_mod.Serial(port, baud, timeout=READ_TIMEOUT_S)
    except (serial_mod.SerialException, OSError, ValueError):
        return False
    try:
        buf = b""
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline and not (cancel is not None and cancel.is_set()):
            buf += ser.read(max(1, ser.in_waiting))
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if _is_node_line(line):
                    return True
            buf = buf[-MAX_LINE_BYTES:]
        return False
    except (serial_mod.SerialException, OSError):
        return False
    finally:
        ser.close()


def find_node_port(serial_mod: ModuleType, baud: int, probe_s: float = PROBE_S,
                   cancel: threading.Event | None = None) -> str | None:
    """``port: auto``: the first candidate printing AeroVolt lines, else the first
    ``ttyACM``/``ttyUSB`` device, else ``None``. ``cancel`` aborts the probing."""
    ports = list_candidate_ports()
    for port in ports:
        if cancel is not None and cancel.is_set():
            return None
        if probe_port(serial_mod, port, baud, probe_s, cancel):
            return port
    return next((p for p in ports if _FALLBACK_RE.search(p)), None)


@register_source("serial")
class SerialSource(Source):
    """A sensor node on a (USB) serial port - see the module docstring."""

    default_label = "Serial sensor node"

    def __init__(self, cfg: dict[str, Any], ctx: SessionContext) -> None:
        super().__init__(cfg, ctx)
        self.serial = import_hardware("serial")  # fail early with a friendly message
        self.port_setting = str(self.cfg.get("port") or "auto")
        self.baud = int(self.cfg.get("baud", 115200))
        self.reconnect_s = float(self.cfg.get("reconnect_s", RECONNECT_S))
        self.probe_s = float(self.cfg.get("probe_s", PROBE_S))
        self.port: str | None = None
        self.announced: list[str] = []
        self.unknown_ids: set[str] = set()
        self.stats = {
            "port": None, "lines": 0, "samples": 0, "checksum_errors": 0, "malformed": 0,
            "unknown_channels": 0, "dropped": 0, "node": None, "fw_version": None,
            "rate_hz": 0.0, "last_hello": None, "last_status": None, "connects": 0,
        }
        self._rate_window: deque[float] = deque()
        self.detail = f"looking for {'a sensor node' if self.port_setting == 'auto' else self.port_setting}"

    # ------------------------------------------------------------------ Source API

    async def run(self, emit: Emit) -> None:
        """Connect, read until the port fails, wait ``reconnect_s``, repeat - until cancelled."""
        while True:
            port = await self._resolve_port()
            if port is not None:
                try:
                    ser = await asyncio.to_thread(self._open, port)
                except (self.serial.SerialException, OSError, ValueError) as exc:
                    self._waiting(self._open_error_text(port, exc))
                else:
                    await self._pump(ser, port, emit)
            await asyncio.sleep(self.reconnect_s)

    # ------------------------------------------------------------------ connection

    async def _resolve_port(self) -> str | None:
        if self.port_setting.lower() != "auto":
            return self.port_setting
        self.status, self.detail = "waiting", "auto: probing serial ports for a sensor node"
        cancel = threading.Event()
        try:
            port = await asyncio.to_thread(find_node_port, self.serial, self.baud, self.probe_s, cancel)
        except asyncio.CancelledError:
            cancel.set()  # let the probing thread finish quickly
            raise
        if port is None:
            self._waiting(f"auto: no sensor node found - plug one in (retrying every {self.reconnect_s:g} s)")
        return port

    def _open(self, port: str) -> Any:
        return self.serial.Serial(port, self.baud, timeout=READ_TIMEOUT_S)

    def _open_error_text(self, port: str, exc: Exception) -> str:
        text = str(exc)
        if "No such file" in text or "could not open port" in text or "FileNotFoundError" in text:
            try:
                available = ", ".join(list_candidate_ports()) or "none"
            except Exception:  # noqa: BLE001 - only used to make the message more helpful
                available = "unknown"
            return (f"port {port} not found - is the node plugged in? available ports: {available} "
                    f"(retrying every {self.reconnect_s:g} s)")
        return f"cannot open {port}: {text} (retrying every {self.reconnect_s:g} s)"

    def _waiting(self, detail: str) -> None:
        if detail != self.detail:
            log.info("serial source %s: %s", self.label, detail)
        self.status, self.detail = "waiting", detail
        self.stats["rate_hz"] = 0.0

    async def _pump(self, ser: Any, port: str, emit: Emit) -> None:
        """Run the reader thread for an open port and process its lines until it fails."""
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[Any] = asyncio.Queue()
        stop = threading.Event()

        def deliver(item: Any) -> None:  # runs on the loop thread
            if queue.qsize() >= QUEUE_MAX and not isinstance(item, _Disconnected):
                self.stats["dropped"] += 1
                return
            queue.put_nowait(item)

        def post(item: Any) -> None:  # runs on the reader thread
            try:
                loop.call_soon_threadsafe(deliver, item)
            except RuntimeError:  # event loop closed during shutdown
                stop.set()

        thread = threading.Thread(target=self._reader, args=(ser, stop, post),
                                  name=f"serial-reader-{port}", daemon=True)
        self.port = port
        self.stats["port"] = port
        self.stats["connects"] += 1
        self.status, self.detail = "running", f"{port} @ {self.baud} baud (waiting for data)"
        thread.start()
        try:
            while True:
                item = await queue.get()
                if isinstance(item, _Disconnected):
                    self._waiting(f"{port} disconnected ({item.reason}); reconnecting every {self.reconnect_s:g} s")
                    return
                self._handle(item, emit)
        finally:
            stop.set()
            thread.join(timeout=1.0)
            try:
                ser.close()
            except Exception:  # noqa: BLE001 - the device may already be gone
                pass

    def _reader(self, ser: Any, stop: threading.Event, post: Callable[[Any], None]) -> None:
        """Worker thread: bytes -> lines -> parsed items, posted to the event loop."""
        buf = b""
        while not stop.is_set():
            try:
                chunk = ser.read(max(1, ser.in_waiting))
            except Exception as exc:  # noqa: BLE001 - SerialException, OSError, TypeError on close
                if not stop.is_set():
                    post(_Disconnected(str(exc) or type(exc).__name__))
                return
            if not chunk:
                continue
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                post(self._parse(line))
            if len(buf) > MAX_LINE_BYTES:
                buf = b""
                post(ProtocolError("line too long without a newline (wrong baud rate?)"))

    @staticmethod
    def _parse(line: bytes) -> ParsedLine | Exception | None:
        try:
            return parse_line(line, raise_errors=True)
        except ProtocolError as exc:
            return exc

    # ------------------------------------------------------------------ line handling

    def _handle(self, item: ParsedLine | Exception | None, emit: Emit) -> None:
        stats = self.stats
        if item is None:  # blank line or free text (e.g. boot messages)
            return
        if isinstance(item, ChecksumError):
            stats["checksum_errors"] += 1
            return
        if isinstance(item, Exception):
            stats["malformed"] += 1
            return
        stats["lines"] += 1
        t = self.ctx.clock()
        if item.is_data:
            self._count_rate()
            values = self._known(item.values)
            if item.node:
                stats["node"] = item.node
            if values:
                stats["samples"] += len(values)
                emit(t, values)
        elif item.kind == "hello":
            stats.update(node=item.node, fw_version=item.fw_version, last_hello=round(t, 3))
            self.announced = list(item.channels)
            log.info("serial node %s (firmware %s) on %s announces %s", item.node, item.fw_version,
                     self.port, ", ".join(item.channels) or "no channels")
        elif item.kind == "status":
            stats["last_status"] = {"t": round(t, 3), "status": item.status, "message": item.message}
            if item.status != "ok":
                log.warning("serial node %s reports %s: %s", item.node, item.status, item.message)
        self._update_detail()

    def _known(self, values: dict[str, float]) -> dict[str, float]:
        """Drop (and count) channel ids that are not in the catalogue."""
        catalog = self.ctx.catalog
        known = {cid: v for cid, v in values.items() if cid in catalog}
        if len(known) != len(values):
            unknown = set(values) - set(known)
            self.stats["unknown_channels"] += len(unknown)
            if len(self.unknown_ids) < 50:
                new = unknown - self.unknown_ids
                if new:
                    log.warning("serial node sends unknown channel id(s): %s", ", ".join(sorted(new)))
                self.unknown_ids |= unknown
        return known

    def _count_rate(self) -> None:
        """Data lines per second over the last 2 s."""
        now = time.monotonic()
        window = self._rate_window
        window.append(now)
        while window and now - window[0] > 2.0:
            window.popleft()
        span = now - window[0] if len(window) > 1 else 0.0
        self.stats["rate_hz"] = round((len(window) - 1) / span, 1) if span > 0 else 0.0

    def _update_detail(self) -> None:
        node = self.stats["node"]
        fw = self.stats["fw_version"]
        who = f"node {node}" + (f" fw {fw}" if fw else "") if node else "unnamed node"
        self.detail = f"{self.port} @ {self.baud} baud, {who}, {self.stats['rate_hz']:g} lines/s"
