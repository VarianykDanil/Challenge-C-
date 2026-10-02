"""``CanSource``: the car's CAN bus as a data source (``type: can``, SPEC section 7.3).

A python-can ``Bus`` (SocketCAN on a Raspberry Pi / Linux laptop with a USB-CAN adapter,
PEAK, Kvaser, slcan serial adapters, or the in-process ``virtual`` bus used by the tests and
``tools/fake_sensor_node.py``) receives frames in python-can's ``Notifier`` thread. Each
frame is passed to the asyncio event loop, decoded with the DBC (:class:`CanMap`: signal
name == channel id, SNA values dropped) and emitted, timestamped on arrival with the session
clock.

Config::

    - type: can
      label: Car CAN bus
      interface: socketcan        # socketcan | virtual | slcan | pcan | kvaser ...
      channel: can0
      bitrate: 1000000            # classic CAN, 1 Mbit/s
      dbc: can/aerovolt.dbc
      channels: [...]             # optional: only take these channels from the bus

Bus statistics in ``info()['stats']``: ``frames``, ``frames_per_s``, ``unknown_ids``
(frames whose id is not in the DBC, with the first few ids listed), ``decode_errors``
(e.g. a frame shorter than its DBC length), ``error_frames`` (CAN error frames: wiring,
termination or bit-rate problems) and ``bus_load_pct`` - the fraction of the bit rate the
received frames occupy, using the worst-case frame length of an 11-bit data frame:
``47 + 8·DLC`` bits plus up to ``(34 + 8·DLC − 1) // 4`` stuff bits.

If the interface is missing or goes down (``can0`` not configured, adapter unplugged) the
source waits and retries every 2 s (``status: waiting``).
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from pathlib import Path
from typing import Any

from aerovolt.core.model import Emit
from aerovolt.core.source import SessionContext, Source, import_hardware, register_source

from .canmap import CanMap, UnknownFrameError

log = logging.getLogger(__name__)

#: Seconds between reconnection attempts.
RECONNECT_S = 2.0
#: Window for frames/s and bus-load statistics, s.
RATE_WINDOW_S = 1.0
#: Frames buffered between the Notifier thread and the event loop before dropping.
QUEUE_MAX = 50_000
#: How many distinct unknown frame ids are listed in the stats.
MAX_UNKNOWN_LISTED = 16


def frame_bits(dlc: int) -> int:
    """Worst-case length in bits of a classic 11-bit data frame with ``dlc`` data bytes.

    44 bits of fixed fields (SOF, id, control, CRC, ACK, EOF) + 3 bits interframe space =
    47, plus the data, plus bit stuffing: after 5 equal bits the controller inserts a
    complementary bit; over the 34 stuffable header bits + data that is at most
    ``(34 + 8·dlc − 1) // 4`` extra bits. DLC 8 gives 135 bits.
    """
    return 47 + 8 * dlc + (34 + 8 * dlc - 1) // 4


class _BusFailure:
    """Posted by the listener when the bus reports an error (interface down...)."""

    def __init__(self, exc: BaseException) -> None:
        self.reason = f"{type(exc).__name__}: {exc}"


@register_source("can")
class CanSource(Source):
    """The car's CAN bus - see the module docstring."""

    default_label = "CAN bus"

    def __init__(self, cfg: dict[str, Any], ctx: SessionContext) -> None:
        super().__init__(cfg, ctx)
        self.can = import_hardware("can")
        self.interface = str(self.cfg.get("interface") or self.cfg.get("bustype") or "socketcan")
        self.channel = str(self.cfg.get("channel", "can0"))
        self.bitrate = int(self.cfg.get("bitrate", 1_000_000))
        self.reconnect_s = float(self.cfg.get("reconnect_s", RECONNECT_S))
        dbc = Path(self.cfg.get("dbc") or "can/aerovolt.dbc")
        self.dbc_path = dbc if dbc.is_absolute() else Path(ctx.root) / dbc
        self.map = CanMap.from_dbc(self.dbc_path, self.cfg.get("channels"))
        self._unknown_listed: list[str] = []
        self._window: deque[tuple[float, int]] = deque()  # (arrival, bits)
        self._window_bits = 0
        self._last_detail = -1.0
        self.stats = {
            "interface": self.interface, "channel": self.channel, "bitrate": self.bitrate,
            "frames": 0, "frames_per_s": 0.0, "samples": 0, "unknown_ids": 0, "unknown_id_list": [],
            "decode_errors": 0, "error_frames": 0, "dropped": 0, "bus_load_pct": 0.0, "connects": 0,
        }
        self.detail = f"{self.interface}:{self.channel} (connecting)"

    # ------------------------------------------------------------------ Source API

    async def run(self, emit: Emit) -> None:
        """Open the bus, receive until it fails, retry every ``reconnect_s``; until cancelled."""
        while True:
            try:
                bus = await asyncio.to_thread(self._open_bus)
            except Exception as exc:  # noqa: BLE001 - CanError, OSError, ValueError, ImportError
                self._waiting(self._open_error_text(exc))
            else:
                await self._receive(bus, emit)
            await asyncio.sleep(self.reconnect_s)

    # ------------------------------------------------------------------ connection

    def _open_bus(self) -> Any:
        return self.can.Bus(interface=self.interface, channel=self.channel, bitrate=self.bitrate)

    def _open_error_text(self, exc: Exception) -> str:
        hint = ""
        if self.interface == "socketcan":
            hint = (f" - is it up? sudo ip link set {self.channel} up type can bitrate {self.bitrate}")
        return f"{self.interface}:{self.channel} not available ({exc}){hint}; retrying every {self.reconnect_s:g} s"

    def _waiting(self, detail: str) -> None:
        if detail != self.detail:
            log.info("CAN source %s: %s", self.label, detail)
        self.status, self.detail = "waiting", detail
        self.stats["frames_per_s"] = 0.0
        self.stats["bus_load_pct"] = 0.0

    async def _receive(self, bus: Any, emit: Emit) -> None:
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[Any] = asyncio.Queue()
        can = self.can

        def deliver(item: Any) -> None:  # loop thread
            if queue.qsize() >= QUEUE_MAX and not isinstance(item, _BusFailure):
                self.stats["dropped"] += 1
                return
            queue.put_nowait(item)

        def post(item: Any) -> None:  # Notifier thread
            try:
                loop.call_soon_threadsafe(deliver, item)
            except RuntimeError:  # loop closed during shutdown
                pass

        class Listener(can.Listener):  # type: ignore[name-defined, misc]
            def on_message_received(self, msg: Any) -> None:
                post(msg)

            def on_error(self, exc: Exception) -> None:
                post(_BusFailure(exc))

        notifier = can.Notifier(bus, [Listener()], timeout=0.1)
        self.stats["connects"] += 1
        self.status, self.detail = "running", f"{self.interface}:{self.channel} @ {self.bitrate // 1000} kbit/s"
        try:
            while True:
                item = await queue.get()
                if isinstance(item, _BusFailure):
                    self._waiting(f"{self.interface}:{self.channel} failed ({item.reason}); "
                                  f"reconnecting every {self.reconnect_s:g} s")
                    return
                self._handle(item, emit)
        finally:
            notifier.stop(timeout=1.0)
            try:
                bus.shutdown()
            except Exception:  # noqa: BLE001 - adapter may already be gone
                pass

    # ------------------------------------------------------------------ frames

    def _handle(self, msg: Any, emit: Emit) -> None:
        stats = self.stats
        if msg.is_error_frame:
            stats["error_frames"] += 1
            return
        if msg.is_remote_frame:
            return
        stats["frames"] += 1
        self._count(int(msg.dlc))
        if msg.is_extended_id:
            self._unknown(msg.arbitration_id, extended=True)
            return
        try:
            values = self.map.decode(msg.arbitration_id, msg.data)
        except UnknownFrameError:
            self._unknown(msg.arbitration_id)
            return
        except ValueError as exc:
            stats["decode_errors"] += 1
            if stats["decode_errors"] in (1, 10, 100, 1000):
                log.warning("CAN decode error #%d: %s", stats["decode_errors"], exc)
            return
        if values:
            stats["samples"] += len(values)
            emit(self.ctx.clock(), values)

    def _unknown(self, frame_id: int, extended: bool = False) -> None:
        self.stats["unknown_ids"] += 1
        text = f"0x{frame_id:08X}" if extended else f"0x{frame_id:03X}"
        if text not in self._unknown_listed and len(self._unknown_listed) < MAX_UNKNOWN_LISTED:
            self._unknown_listed.append(text)
            self.stats["unknown_id_list"] = list(self._unknown_listed)

    def _count(self, dlc: int) -> None:
        """Update frames/s and bus load over the last :data:`RATE_WINDOW_S` (O(1) per frame)."""
        now = time.monotonic()
        window = self._window
        bits = frame_bits(dlc)
        window.append((now, bits))
        self._window_bits += bits
        while now - window[0][0] > RATE_WINDOW_S:
            self._window_bits -= window.popleft()[1]
        if len(window) < 2 or now - self._last_detail < 0.5:
            return
        span = now - window[0][0]
        if span <= 0:
            return
        # The first frame of the window only marks its start: count the bits after it.
        self.stats["frames_per_s"] = round((len(window) - 1) / span, 1)
        self.stats["bus_load_pct"] = round(100.0 * (self._window_bits - window[0][1]) / span / self.bitrate, 2)
        self._last_detail = now
        self.detail = (f"{self.interface}:{self.channel} @ {self.bitrate // 1000} kbit/s, "
                       f"{self.stats['frames_per_s']:g} frames/s, load {self.stats['bus_load_pct']:g} %")
