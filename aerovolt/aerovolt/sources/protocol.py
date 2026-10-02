"""The AeroVolt serial line protocol: what a USB-serial sensor node prints (SPEC section 7.1).

Three NMEA-style sentence types, one per line, ASCII, terminated by ``\\r\\n``::

    $AV,<node>,<ms>,<ch>=<value>[,<ch>=<value>...]*<CS>      data
    $AVH,<node>,<fw_version>,<ch>[,<ch>...]*<CS>              hello (at boot and every 5 s)
    $AVS,<node>,<ms>,<status>,<message>*<CS>                  status (ok | warn | error)

* ``<node>`` - the node's name, e.g. ``AERO1`` (no commas, no ``*``).
* ``<ms>`` - the node's own millisecond counter (``millis()``). It is informational: the
  host timestamps samples when they *arrive*, so nodes need no synchronised clock.
* ``<ch>=<value>`` - a catalogue channel id and a decimal number (``nan`` = not available).
* ``<CS>`` - checksum: two hex digits, the XOR of every byte between ``$`` and ``*``
  (exactly the NMEA 0183 rule). It catches the typical corruption of a noisy USB/UART
  link (a flipped bit, a dropped character); a line with a wrong checksum is dropped.

Worked checksum example: for ``$AV,N1,0,a=1*CS`` the bytes between ``$`` and ``*`` are
``AV,N1,0,a=1``; XOR-ing their ASCII codes gives ``0x19``, so the line is
``$AV,N1,0,a=1*19``.

For beginners (an Arduino sketch printing one JSON object per line) the parser also accepts
``{"fw_p03": -412.5, "amb_temp": 18.4}`` - no node name, no checksum.

The parser is tolerant of what real serial links and hand-written firmware produce:
surrounding whitespace, ``\\r\\n`` or ``\\n`` line ends, lower-case hex checksums, spaces
around ``=``. It is strict about what matters: the checksum must match, every value must be
a number, and channel ids must look like ids.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from typing import Iterable, Mapping

#: Sentence tags (the text between ``$`` and the first comma).
TAG_DATA = "AV"
TAG_HELLO = "AVH"
TAG_STATUS = "AVS"

#: Allowed status words in ``$AVS`` sentences.
STATUS_WORDS = ("ok", "warn", "error")

#: A channel id: lower-case snake_case, e.g. ``fw_p03``, ``cell_v_047``.
_CHANNEL_RE = re.compile(r"^[a-z][a-z0-9_]*$")
#: A node name or firmware version: printable, no separators.
_TOKEN_RE = re.compile(r"^[^,*$\s]+$")

NAN = float("nan")


class ProtocolError(ValueError):
    """A line that claims to be an AeroVolt sentence (or JSON object) but is malformed."""


class ChecksumError(ProtocolError):
    """The ``*CS`` checksum does not match the sentence (corrupted line)."""


@dataclass
class ParsedLine:
    """One decoded line.

    ``kind`` is ``'data'`` (``$AV``), ``'hello'`` (``$AVH``), ``'status'`` (``$AVS``) or
    ``'json'`` (beginner JSON object; treated like data). Fields that a kind does not
    carry are ``None`` / empty.
    """

    kind: str
    node: str | None = None
    ms: int | None = None
    values: dict[str, float] = field(default_factory=dict)  # data / json
    fw_version: str | None = None  # hello
    channels: list[str] = field(default_factory=list)  # hello
    status: str | None = None  # status
    message: str | None = None  # status

    @property
    def is_data(self) -> bool:
        """True for lines that carry channel values (``$AV`` and JSON)."""
        return self.kind in ("data", "json")


# --------------------------------------------------------------------------------------
# Checksum
# --------------------------------------------------------------------------------------


def checksum(payload: str | bytes) -> int:
    """NMEA checksum: XOR of every byte of ``payload`` (the text between ``$`` and ``*``)."""
    data = payload.encode("ascii") if isinstance(payload, str) else payload
    cs = 0
    for byte in data:
        cs ^= byte
    return cs


def with_checksum(payload: str) -> str:
    """``payload`` -> ``$payload*CS`` (no line ending)."""
    return f"${payload}*{checksum(payload):02X}"


# --------------------------------------------------------------------------------------
# Formatting (used by the fake sensor node, tests and documentation)
# --------------------------------------------------------------------------------------


def format_value(value: float | int | None) -> str:
    """Shortest decimal text that reads back as the same float; ``nan`` for missing.

    ``repr(float)`` is the shortest round-tripping representation, so -412.5 stays
    ``-412.5`` and a GPS latitude keeps all its digits.
    """
    if value is None:
        return "nan"
    x = float(value)
    if not math.isfinite(x):
        return "nan"
    if x == int(x) and abs(x) < 1e15:
        return str(int(x))
    return repr(x)


def _check_token(kind: str, text: str) -> str:
    text = str(text)
    if not _TOKEN_RE.match(text):
        raise ValueError(f"{kind} {text!r} must be non-empty and contain no ',', '*', '$' or spaces")
    return text


def _check_channel(cid: str) -> str:
    if not _CHANNEL_RE.match(cid):
        raise ValueError(f"channel id {cid!r} is not a snake_case id")
    return cid


def format_data(node: str, ms: int, values: Mapping[str, float], *, newline: bool = True) -> str:
    """A ``$AV`` data sentence, e.g. ``$AV,AERO1,1234,fw_p03=-412.5*16\\r\\n``."""
    if not values:
        raise ValueError("a data sentence needs at least one value")
    body = ",".join(f"{_check_channel(cid)}={format_value(v)}" for cid, v in values.items())
    line = with_checksum(f"{TAG_DATA},{_check_token('node', node)},{int(ms)},{body}")
    return line + "\r\n" if newline else line


def format_hello(node: str, fw_version: str, channels: Iterable[str], *, newline: bool = True) -> str:
    """A ``$AVH`` hello sentence announcing the node, firmware version and its channels."""
    chans = [_check_channel(c) for c in channels]
    parts = [TAG_HELLO, _check_token("node", node), _check_token("fw_version", fw_version), *chans]
    line = with_checksum(",".join(parts))
    return line + "\r\n" if newline else line


def format_status(node: str, ms: int, status: str, message: str = "", *, newline: bool = True) -> str:
    """A ``$AVS`` status sentence; ``status`` is ``ok``, ``warn`` or ``error``."""
    if status not in STATUS_WORDS:
        raise ValueError(f"status must be one of {STATUS_WORDS}, got {status!r}")
    if any(c in message for c in "*$\r\n"):
        raise ValueError("status message must not contain '*', '$' or line breaks")
    line = with_checksum(f"{TAG_STATUS},{_check_token('node', node)},{int(ms)},{status},{message}")
    return line + "\r\n" if newline else line


# --------------------------------------------------------------------------------------
# Parsing
# --------------------------------------------------------------------------------------


def _parse_number(text: str, what: str) -> float:
    t = text.strip()
    if t.lower() in ("nan", "", "null", "none"):
        return NAN
    try:
        x = float(t)
    except ValueError:
        raise ProtocolError(f"{what}: {text!r} is not a number") from None
    return x if math.isfinite(x) else NAN


def _parse_int(text: str, what: str) -> int:
    try:
        return int(text.strip())
    except ValueError:
        raise ProtocolError(f"{what}: {text!r} is not an integer") from None


def _parse_sentence(line: str) -> ParsedLine:
    star = line.rfind("*")
    if star < 0:
        raise ProtocolError("sentence has no '*<checksum>'")
    payload, cs_text = line[1:star], line[star + 1:].strip()
    if len(cs_text) != 2:
        raise ProtocolError(f"checksum {cs_text!r} must be two hex digits")
    try:
        cs = int(cs_text, 16)
    except ValueError:
        raise ProtocolError(f"checksum {cs_text!r} is not hexadecimal") from None
    expected = checksum(payload.encode("ascii", errors="replace"))
    if cs != expected:
        raise ChecksumError(f"checksum {cs_text} does not match (expected {expected:02X})")

    fields = payload.split(",")
    tag = fields[0].strip().upper()
    if tag == TAG_DATA:
        if len(fields) < 4:
            raise ProtocolError("data sentence needs $AV,<node>,<ms>,<ch>=<value>")
        node, ms = fields[1].strip(), _parse_int(fields[2], "ms")
        values: dict[str, float] = {}
        for item in fields[3:]:
            name, eq, text = item.partition("=")
            cid = name.strip()
            if not eq or not _CHANNEL_RE.match(cid):
                raise ProtocolError(f"bad '<channel>=<value>' item {item!r}")
            values[cid] = _parse_number(text, cid)
        return ParsedLine("data", node=node, ms=ms, values=values)
    if tag == TAG_HELLO:
        if len(fields) < 3:
            raise ProtocolError("hello sentence needs $AVH,<node>,<fw_version>[,<ch>...]")
        channels = [c.strip() for c in fields[3:] if c.strip()]
        bad = [c for c in channels if not _CHANNEL_RE.match(c)]
        if bad:
            raise ProtocolError(f"bad channel id(s) in hello: {bad}")
        return ParsedLine("hello", node=fields[1].strip(), fw_version=fields[2].strip(), channels=channels)
    if tag == TAG_STATUS:
        if len(fields) < 4:
            raise ProtocolError("status sentence needs $AVS,<node>,<ms>,<status>,<message>")
        status = fields[3].strip().lower()
        if status not in STATUS_WORDS:
            raise ProtocolError(f"unknown status {status!r} (expected ok, warn or error)")
        message = ",".join(fields[4:]).strip()
        return ParsedLine("status", node=fields[1].strip(), ms=_parse_int(fields[2], "ms"),
                          status=status, message=message)
    raise ProtocolError(f"unknown sentence type ${tag}")


def _parse_json(line: str) -> ParsedLine:
    try:
        obj = json.loads(line)
    except json.JSONDecodeError as exc:
        raise ProtocolError(f"invalid JSON: {exc.msg}") from None
    if not isinstance(obj, dict) or not obj:
        raise ProtocolError("a JSON line must be a non-empty object {\"channel\": value, ...}")
    values: dict[str, float] = {}
    for key, value in obj.items():
        cid = str(key).strip()
        if not _CHANNEL_RE.match(cid):
            raise ProtocolError(f"bad channel id {key!r} in JSON line")
        if value is None:
            values[cid] = NAN
        elif isinstance(value, bool):
            values[cid] = 1.0 if value else 0.0
        elif isinstance(value, (int, float)):
            values[cid] = float(value) if math.isfinite(value) else NAN
        elif isinstance(value, str):
            values[cid] = _parse_number(value, cid)
        else:
            raise ProtocolError(f"{cid}: value must be a number, got {type(value).__name__}")
    return ParsedLine("json", values=values)


def parse_line(line: str | bytes, *, raise_errors: bool = False) -> ParsedLine | None:
    """Decode one line printed by a sensor node.

    Returns a :class:`ParsedLine`, or ``None`` when the line carries nothing usable:
    blank lines, boot messages and other free text (anything not starting with ``$`` or
    ``{``) are always ``None``. Corrupted protocol lines (bad checksum, malformed fields)
    are ``None`` too - or, with ``raise_errors=True``, raise :class:`ChecksumError` /
    :class:`ProtocolError` so a caller can count them (the serial source does).
    """
    if isinstance(line, bytes):
        line = line.decode("ascii", errors="replace")
    text = line.strip().lstrip("﻿")
    if not text or text[0] not in "${":
        return None
    try:
        return _parse_sentence(text) if text[0] == "$" else _parse_json(text)
    except ProtocolError:
        if raise_errors:
            raise
        return None
