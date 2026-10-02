"""CAN bus helpers shared by the DBC generator, the CAN source and the firmware tests.

This module holds the CAN "signal not available" (SNA) helpers (they live here rather than
in :mod:`aerovolt.core.physics` because they are bus conventions, not physics) and the
loader of ``config/can_layout.yaml`` (SPEC section 7.3).

Conventions (SPEC section 7.3)
------------------------------
* Classic CAN, 11-bit identifiers, Intel (little-endian) byte order, DLC 8 for every frame.
  Signals are packed back to back from bit 0 in the order listed in the layout.
* Signal name == channel id of the catalogue.
* SNA: the raw value ``0x80...0`` (most negative) for signed signals, all ones for unsigned
  signals. A decoder that sees SNA does not update the channel; a sender that does not own
  every signal of a frame fills the others with SNA. *Exception:* 1-bit flags have no SNA
  (all-ones would be the value ``1`` = true), so they are always valid.

Scaled value <-> raw integer (mirrors cantools 39-44 bit for bit)
-----------------------------------------------------------------
``physical = raw * scale + offset`` and, for encoding,
``raw = round((physical - offset) / scale)`` evaluated in IEEE-754 double precision with
Python's ``round()``, i.e. **round half to even** (banker's rounding), *not* truncation and
not round-half-away-from-zero. In C/C++ ``std::nearbyint`` in the default FE_TONEAREST mode
is the exact equivalent. (cantools special-cases integer scale and offset by subtracting the
offset first and dividing only when needed; for the scales used here the result is
identical.) Values outside the signal range are clamped to the nearest valid raw value
(cantools' strict mode would raise instead), and NaN is encoded as SNA.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping

import yaml

#: Bits per frame (classic CAN, DLC 8).
FRAME_BITS = 64

#: Integer types usable in ``config/can_layout.yaml``: name -> (length in bits, signed, has SNA).
CAN_TYPES: dict[str, tuple[int, bool, bool]] = {
    "flag": (1, False, False),
    "u8": (8, False, True),
    "i8": (8, True, True),
    "u16": (16, False, True),
    "i16": (16, True, True),
    "u32": (32, False, True),
    "i32": (32, True, True),
}


# --------------------------------------------------------------------------------------
# SNA and raw-range helpers
# --------------------------------------------------------------------------------------


def sna_raw(length: int, signed: bool) -> int:
    """Raw "signal not available" value: ``-2**(length-1)`` if signed, else ``2**length - 1``.

    As a two's-complement bit pattern both are the familiar ``0x8000...`` / ``0xFFFF...``.
    """
    return -(1 << (length - 1)) if signed else (1 << length) - 1


def is_sna(raw: int, length: int, signed: bool) -> bool:
    """True if ``raw`` (as decoded: negative for signed signals) is the SNA value.

    Accepts the signed value or the unsigned two's-complement bit pattern for signed
    signals, so it works on both ``cantools`` output and raw bit fields.
    """
    if length == 1:
        return False
    if signed:
        return raw == sna_raw(length, True) or raw == (1 << (length - 1))
    return raw == sna_raw(length, False)


def raw_limits(length: int, signed: bool, has_sna: bool = True) -> tuple[int, int]:
    """Smallest and largest raw values that encode a *valid* reading (SNA excluded)."""
    if signed:
        lo, hi = -(1 << (length - 1)), (1 << (length - 1)) - 1
        return (lo + 1 if has_sna else lo), hi
    hi = (1 << length) - 1
    return 0, (hi - 1 if has_sna else hi)


def scaled_to_raw(value: float, scale: float, offset: float) -> int:
    """Physical value -> raw integer exactly like cantools: ``round((v - offset) / scale)``.

    Python's ``round`` is round-half-to-even (see module docstring). No clamping here.
    """
    return round((value - offset) / scale)


def raw_to_scaled(raw: int, scale: float, offset: float) -> float:
    """Raw integer -> physical value: ``raw * scale + offset``."""
    return raw * scale + offset


# --------------------------------------------------------------------------------------
# Layout model
# --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class CanSignal:
    """One signal of a frame. ``name`` is the catalogue channel id."""

    name: str
    start_bit: int
    length: int
    is_signed: bool
    scale: float
    offset: float = 0.0
    has_sna: bool = True

    @property
    def sna(self) -> int | None:
        """Raw SNA value, or ``None`` for 1-bit flags."""
        return sna_raw(self.length, self.is_signed) if self.has_sna else None

    @property
    def raw_min(self) -> int:
        return raw_limits(self.length, self.is_signed, self.has_sna)[0]

    @property
    def raw_max(self) -> int:
        return raw_limits(self.length, self.is_signed, self.has_sna)[1]

    @property
    def phys_min(self) -> float:
        """Smallest encodable physical value (the DBC ``[min|max]`` lower bound)."""
        return clean_float(raw_to_scaled(self.raw_min, self.scale, self.offset))

    @property
    def phys_max(self) -> float:
        """Largest encodable physical value (SNA excluded)."""
        return clean_float(raw_to_scaled(self.raw_max, self.scale, self.offset))

    def encode(self, value: float | None) -> int:
        """Physical value -> raw integer: NaN/None -> SNA, otherwise rounded and clamped."""
        if value is None or not math.isfinite(value):
            if not self.has_sna:
                raise ValueError(f"signal {self.name} has no SNA value; cannot encode NaN")
            return sna_raw(self.length, self.is_signed)
        raw = scaled_to_raw(float(value), self.scale, self.offset)
        return min(max(raw, self.raw_min), self.raw_max)

    def decode(self, raw: int) -> float:
        """Raw integer -> physical value, NaN for SNA."""
        if self.has_sna and is_sna(raw, self.length, self.is_signed):
            return float("nan")
        return raw_to_scaled(raw, self.scale, self.offset)


@dataclass(frozen=True)
class CanMessage:
    """One CAN frame of the layout."""

    id: int
    name: str
    sender: str
    receivers: tuple[str, ...]
    cycle_ms: int
    comment: str
    signals: tuple[CanSignal, ...]
    dlc: int = 8

    @property
    def used_bits(self) -> int:
        return sum(s.length for s in self.signals)


@dataclass
class CanLayout:
    """The whole bus: nodes and frames, in file order."""

    bitrate: int
    nodes: dict[str, str]
    messages: list[CanMessage]
    comment: str = ""
    by_id: dict[int, CanMessage] = field(default_factory=dict, repr=False)
    by_signal: dict[str, tuple[CanMessage, CanSignal]] = field(default_factory=dict, repr=False)

    def __post_init__(self) -> None:
        for msg in self.messages:
            self.by_id[msg.id] = msg
            for sig in msg.signals:
                self.by_signal[sig.name] = (msg, sig)

    def signal_names(self) -> list[str]:
        return [s.name for m in self.messages for s in m.signals]

    def bus_load(self) -> float:
        """Estimated bus load (0..1): worst-case 11-bit frame with 8 data bytes.

        Frame bits = 47 overhead + 64 data + worst-case bit stuffing
        ((34 + 64 - 1) // 4 = 24) = 135 bits.
        """
        bits_per_s = 0.0
        for m in self.messages:
            stuffed = 47 + 8 * m.dlc + (34 + 8 * m.dlc - 1) // 4
            bits_per_s += stuffed * 1000.0 / m.cycle_ms
        return bits_per_s / self.bitrate


def clean_float(x: float) -> float:
    """Remove binary floating-point noise, e.g. ``0.1 * 32767 = 3276.7000000000003``."""
    return float(f"{x:.12g}")


def _signal_entries(spec: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Expand the ``signals`` list (names or dicts) of a message spec into dicts."""
    out: list[dict[str, Any]] = []
    for entry in spec["signals"]:
        item = {"name": entry} if isinstance(entry, str) else dict(entry)
        for key in ("type", "scale", "offset"):
            if key not in item and key in spec:
                item[key] = spec[key]
        out.append(item)
    return out


def _expand_series(spec: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Expand a ``series`` message spec (cell voltages / temperatures) into frames.

    ``series: {channel: "cell_v_{k:03d}", count: 140, per_frame: 4}`` with
    ``name: "BMS_CELL_V_{n:02d}"`` and base ``id`` gives frame ``n`` = id + n carrying the
    channels ``k = per_frame * n ... per_frame * n + per_frame - 1``.
    """
    series = spec["series"]
    count, per_frame = int(series["count"]), int(series["per_frame"])
    frames = []
    for n in range(math.ceil(count / per_frame)):
        names = [series["channel"].format(k=k) for k in range(n * per_frame, min(count, (n + 1) * per_frame))]
        frame = {key: val for key, val in spec.items() if key != "series"}
        frame["id"] = int(spec["id"]) + n
        frame["name"] = spec["name"].format(n=n)
        frame["comment"] = spec.get("comment", "").format(n=n, first=names[0], last=names[-1])
        frame["signals"] = names
        frames.append(frame)
    return frames


def _build_message(spec: Mapping[str, Any], defaults: Mapping[str, Any]) -> CanMessage:
    start = 0
    signals: list[CanSignal] = []
    for item in _signal_entries(spec):
        type_name = item.get("type")
        if type_name not in CAN_TYPES:
            raise ValueError(f"{spec['name']}.{item['name']}: unknown CAN type {type_name!r}")
        length, signed, has_sna = CAN_TYPES[type_name]
        signals.append(CanSignal(
            name=item["name"],
            start_bit=start,
            length=length,
            is_signed=signed,
            scale=float(item.get("scale", 1.0)),
            offset=float(item.get("offset", 0.0)),
            has_sna=has_sna,
        ))
        start += length
    dlc = int(spec.get("dlc", defaults.get("dlc", 8)))
    if start > 8 * dlc:
        raise ValueError(f"{spec['name']}: {start} bits do not fit in DLC {dlc}")
    receivers = spec.get("receivers", defaults.get("receivers", []))
    return CanMessage(
        id=int(spec["id"]),
        name=str(spec["name"]),
        sender=str(spec["sender"]),
        receivers=tuple(receivers),
        cycle_ms=int(spec["cycle_ms"]),
        comment=str(spec.get("comment", "")).strip(),
        signals=tuple(signals),
        dlc=dlc,
    )


def load_can_layout(path: str | Path) -> CanLayout:
    """Parse ``config/can_layout.yaml`` into a validated :class:`CanLayout`.

    Validates: 11-bit IDs, unique IDs, unique message names, unique signal names, senders
    and receivers declared in ``nodes``, and that every frame fits in its DLC.
    """
    data = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    bus = data.get("bus", {})
    defaults = {"dlc": bus.get("dlc", 8), "receivers": bus.get("receivers", [])}
    nodes = {str(k): str(v) for k, v in data["nodes"].items()}
    specs: list[Mapping[str, Any]] = []
    for spec in data["messages"]:
        specs.extend(_expand_series(spec) if "series" in spec else [spec])
    messages = [_build_message(s, defaults) for s in specs]
    _validate(messages, nodes)
    return CanLayout(
        bitrate=int(bus.get("bitrate", 1_000_000)),
        nodes=nodes,
        messages=messages,
        comment=str(data.get("comment", "")).strip(),
    )


def _validate(messages: Iterable[CanMessage], nodes: Mapping[str, str]) -> None:
    ids: set[int] = set()
    names: set[str] = set()
    signals: set[str] = set()
    for m in messages:
        if not 0 <= m.id <= 0x7FF:
            raise ValueError(f"{m.name}: id 0x{m.id:X} is not an 11-bit identifier")
        if m.id in ids or m.name in names:
            raise ValueError(f"duplicate message id/name: 0x{m.id:X} {m.name}")
        ids.add(m.id)
        names.add(m.name)
        for node in (m.sender, *m.receivers):
            if node not in nodes:
                raise ValueError(f"{m.name}: node {node!r} is not declared in 'nodes'")
        for s in m.signals:
            if s.name in signals:
                raise ValueError(f"signal {s.name} appears in more than one message")
            signals.add(s.name)
