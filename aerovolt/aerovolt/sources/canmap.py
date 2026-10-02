"""CAN frames <-> channel values, driven by the DBC file (SPEC section 7.3).

``can/aerovolt.dbc`` is generated from ``config/can_layout.yaml`` by ``tools/gen_can.py``;
every signal is named after the catalogue channel it carries, so decoding a frame directly
gives ``{channel id: value}`` - no hand-written mapping table to keep in sync.

Decoding, step by step (one frame):

1. look the frame id up in the DBC (unknown ids are reported, not guessed);
2. let cantools unpack the **raw** integers (``scaling=False``) - Intel byte order, signed
   fields sign-extended;
3. drop every signal whose raw value is the *signal-not-available* code
   (:func:`aerovolt.core.canutil.is_sna`: ``0x80..0`` for signed, all ones for unsigned
   fields; 1-bit flags have no SNA). A node that does not measure a signal of a shared
   frame sends SNA there, and SNA must never overwrite a real value with garbage;
4. scale the rest: ``physical = raw * scale + offset``.

The SNA test is done on the raw integer on purpose: after scaling, ``-32768 * 0.1`` is just
another plausible pressure (-3276.8 Pa).

Encoding (tests, ``tools/fake_sensor_node.py``) is the mirror image: values are rounded
half-to-even and clamped exactly like the firmware (:meth:`CanSignal.encode`), NaN and
every signal the sender does not own become SNA (1-bit flags become 0).

cantools is imported lazily (``requirements-hw.txt``).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping

from aerovolt.core.canutil import CanSignal
from aerovolt.core.source import import_hardware


class UnknownFrameError(KeyError):
    """The frame id is not in the DBC."""


@dataclass(frozen=True)
class FrameDef:
    """One DBC message: the cantools object plus our signal descriptions (name = channel)."""

    id: int
    name: str
    length: int
    message: Any  # cantools.database.can.Message
    signals: tuple[CanSignal, ...]


def _signal_from_cantools(sig: Any) -> CanSignal:
    if sig.byte_order != "little_endian":
        raise ValueError(f"signal {sig.name}: only Intel (little-endian) signals are supported")
    return CanSignal(
        name=sig.name,
        start_bit=int(sig.start),
        length=int(sig.length),
        is_signed=bool(sig.is_signed),
        scale=float(sig.scale),
        offset=float(sig.offset),
        has_sna=int(sig.length) > 1,  # SPEC 7.3: every multi-bit signal reserves an SNA code
    )


class CanMap:
    """Decoder / encoder for every frame of a DBC (see the module docstring).

    ``channels`` (optional) restricts decoding to those channel ids - a frame that only
    carries other channels decodes to ``{}``.
    """

    def __init__(self, database: Any, channels: Iterable[str] | None = None) -> None:
        self.database = database
        self.channels: frozenset[str] | None = frozenset(channels) if channels else None
        self.frames: dict[int, FrameDef] = {}
        self.by_name: dict[str, FrameDef] = {}
        self.by_signal: dict[str, tuple[FrameDef, CanSignal]] = {}
        for msg in database.messages:
            if msg.is_extended_frame:
                raise ValueError(f"{msg.name}: AeroVolt uses 11-bit identifiers only")
            frame = FrameDef(int(msg.frame_id), msg.name, int(msg.length), msg,
                             tuple(_signal_from_cantools(s) for s in msg.signals))
            self.frames[frame.id] = frame
            self.by_name[frame.name] = frame
            for sig in frame.signals:
                self.by_signal[sig.name] = (frame, sig)
        # Decoding plan per frame id: only the signals we want.
        self._plan: dict[int, tuple[CanSignal, ...]] = {
            fid: tuple(s for s in f.signals if self.channels is None or s.name in self.channels)
            for fid, f in self.frames.items()
        }

    @classmethod
    def from_dbc(cls, path: str | Path, channels: Iterable[str] | None = None) -> CanMap:
        """Load a DBC file (cp1252, the Vector convention used by ``gen_can.py``)."""
        cantools = import_hardware("cantools")
        return cls(cantools.database.load_file(str(path)), channels)

    # ------------------------------------------------------------------ decoding

    def __contains__(self, frame_id: int) -> bool:
        return frame_id in self.frames

    def signal_names(self) -> list[str]:
        """Every channel the DBC can carry, in frame order."""
        return [s.name for f in self.frames.values() for s in f.signals]

    def decode(self, frame_id: int, data: bytes | bytearray) -> dict[str, float]:
        """Frame -> ``{channel: physical value}`` with SNA signals left out.

        Raises :class:`UnknownFrameError` for an id that is not in the DBC and
        ``ValueError`` (from cantools) for a payload that is too short.
        """
        frame = self.frames.get(frame_id)
        if frame is None:
            raise UnknownFrameError(frame_id)
        plan = self._plan[frame_id]
        if not plan:
            return {}
        try:
            raw = frame.message.decode(bytes(data), decode_choices=False, scaling=False)
        except Exception as exc:  # cantools.DecodeError, bitstruct errors
            raise ValueError(f"cannot decode {frame.name} (0x{frame_id:03X}, {len(data)} bytes): {exc}") from exc
        out: dict[str, float] = {}
        for sig in plan:
            value = raw.get(sig.name)
            if value is None:
                continue
            physical = sig.decode(int(value))  # NaN for SNA
            if not math.isnan(physical):
                out[sig.name] = physical
        return out

    # ------------------------------------------------------------------ encoding

    def frame(self, message: int | str) -> FrameDef:
        """Frame by id or name (``KeyError`` if unknown)."""
        f = self.frames.get(message) if isinstance(message, int) else self.by_name.get(message)
        if f is None:
            raise UnknownFrameError(message)
        return f

    def encode(self, message: int | str, values: Mapping[str, float]) -> bytes:
        """Pack one frame. Signals missing from ``values`` (or NaN) are sent as SNA;
        1-bit flags that are missing are sent as 0. Values are rounded and clamped."""
        frame = self.frame(message)
        raw: dict[str, int] = {}
        for sig in frame.signals:
            value = values.get(sig.name)
            missing = value is None or not math.isfinite(float(value))
            if missing and not sig.has_sna:
                raw[sig.name] = 0
            else:
                raw[sig.name] = sig.encode(None if missing else float(value))
        data = frame.message.encode(raw, scaling=False, strict=False, padding=False)
        return bytes(data).ljust(frame.length, b"\x00")

    def frames_for(self, channels: Iterable[str]) -> list[FrameDef]:
        """The frames (in id order) that carry any of ``channels``."""
        ids = {self.by_signal[c][0].id for c in channels if c in self.by_signal}
        return [self.frames[i] for i in sorted(ids)]

    def encode_all(self, values: Mapping[str, float]) -> list[tuple[int, bytes]]:
        """Every frame that carries at least one of ``values``: ``[(id, data), ...]``."""
        return [(f.id, self.encode(f.id, values)) for f in self.frames_for(values)]
