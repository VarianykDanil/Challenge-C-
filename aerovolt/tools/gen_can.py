#!/usr/bin/env python3
"""Generate the CAN database and the firmware header from ``config/can_layout.yaml``.

Outputs (both deterministic - no timestamps - so ``--check`` can compare byte for byte):

* ``can/aerovolt.dbc`` - Vector DBC file (cp1252 encoded, as Vector tools expect) for
  cantools, CANdb++, SavvyCAN, PCAN-Explorer ... with nodes, messages, signals (Intel byte
  order ``@1``, ``+`` unsigned / ``-`` signed), units and ranges taken from the channel
  catalogue, ``CM_`` comments for every node, message and signal, ``GenMsgCycleTime``
  attributes and ``VAL_`` tables for enums and the SNA value.
* ``firmware/sensor_node/include/aerovolt_can.h`` - header-only C++17 description of the
  same layout (``namespace aerovolt::can``) for the sensor-node firmware.

Usage::

    python tools/gen_can.py            # (re)write both files
    python tools/gen_can.py --check    # exit 1 if either file is missing or out of date

How a physical value becomes a raw integer (the firmware MUST mirror this bit for bit)
---------------------------------------------------------------------------------------
Read from cantools 44 (``cantools/database/conversion.py``, ``LinearConversion`` /
``LinearIntegerConversion.numeric_scaled_to_raw``)::

    raw = round((value - offset) / scale)        # Python round(): ROUND HALF TO EVEN

computed in IEEE-754 double precision. It is *rounding*, not truncation, and ties go to
the even integer (0.5 -> 0, 1.5 -> 2, -2.5 -> -2). For integer scale/offset cantools first
subtracts the offset and only divides when the remainder is non-zero, which gives the same
integer. The C/C++ equivalent is ``std::nearbyint((value - offset) / scale)`` with the
default FE_TONEAREST rounding mode (NOT ``std::round``, which rounds ties away from zero,
and NOT a cast, which truncates). Decoding is ``value = raw * scale + offset``.

Out-of-range values: cantools (``strict=True``, the default) refuses to encode a value
outside the DBC ``[min|max]`` (``EncodeError``). AeroVolt senders instead clamp to the valid
raw range, which excludes the SNA code, and encode NaN as SNA
(:meth:`aerovolt.core.canutil.CanSignal.encode`). Bits not covered by a signal are sent as
0 (cantools' default ``padding=False``). Signed signals are two's complement.
"""

from __future__ import annotations

import argparse
import sys
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from aerovolt import __version__  # noqa: E402
from aerovolt.core.canutil import CanLayout, CanMessage, CanSignal, clean_float, load_can_layout  # noqa: E402
from aerovolt.core.catalog import Catalog  # noqa: E402

LAYOUT_PATH = ROOT / "config" / "can_layout.yaml"
SENSORS_PATH = ROOT / "config" / "sensors.yaml"
DBC_PATH = ROOT / "can" / "aerovolt.dbc"
HEADER_PATH = ROOT / "firmware" / "sensor_node" / "include" / "aerovolt_can.h"

#: DBC files are traditionally Windows-1252; it has ° and ² but not Ω.
DBC_ENCODING = "cp1252"
_DBC_UNIT_REPLACEMENTS = {"Ω": "Ohm"}


def dbc_unit(unit: str) -> str:
    """Catalogue unit -> DBC unit string (cp1252-safe: kΩ -> kOhm)."""
    for old, new in _DBC_UNIT_REPLACEMENTS.items():
        unit = unit.replace(old, new)
    return unit


def fmt_num(x: float) -> str:
    """Plain decimal notation without float noise: 0.1 -> '0.1', 1e-7 -> '0.0000001',
    0.1 * 32767 -> '3276.7' (12 significant digits)."""
    x = clean_float(float(x))
    if x.is_integer():
        return str(int(x))
    return format(Decimal(repr(x)).normalize(), "f")


def _dbc_text(text: str) -> str:
    """Make a string safe inside DBC double quotes (no quotes, cp1252 units, one line)."""
    return " ".join(dbc_unit(text).replace('"', "'").split())


def _signal_comment(sig: CanSignal, catalog: Catalog) -> str:
    ch = catalog[sig.name]
    parts = [ch.name + "."]
    parts.append(f"Sensor range {fmt_num(ch.min)} .. {fmt_num(ch.max)} {ch.unit}.")
    if sig.has_sna:
        parts.append(f"SNA (not available) = raw {sig.sna}.")
    else:
        parts.append("1-bit flag, no SNA value.")
    return _dbc_text(" ".join(parts))


def _value_table(sig: CanSignal, catalog: Catalog) -> list[tuple[int, str]]:
    """``VAL_`` entries: enum labels from the catalogue plus the SNA code."""
    entries: list[tuple[int, str]] = []
    enum = catalog[sig.name].meta.get("enum") or {}
    for raw in sorted(int(k) for k in enum):
        entries.append((raw, _dbc_text(str(enum[raw] if raw in enum else enum[str(raw)]))))
    if sig.has_sna:
        entries.append((int(sig.sna), "SNA"))
    return entries


def render_dbc(layout: CanLayout, catalog: Catalog) -> str:
    """Render the complete DBC file as text."""
    out: list[str] = []
    out.append(f'VERSION "AeroVolt {__version__}"')
    out.append("")
    out.append("NS_ :")
    for keyword in ("NS_DESC_", "CM_", "BA_DEF_", "BA_", "VAL_", "CAT_DEF_", "CAT_", "FILTER",
                    "BA_DEF_DEF_", "EV_DATA_", "ENVVAR_DATA_", "SGTYPE_", "SGTYPE_VAL_",
                    "BA_DEF_SGTYPE_", "BA_SGTYPE_", "SIG_TYPE_REF_", "VAL_TABLE_", "SIG_GROUP_",
                    "SIG_VALTYPE_", "SIGTYPE_VALTYPE_", "BO_TX_BU_", "BA_DEF_REL_", "BA_REL_",
                    "BA_DEF_DEF_REL_", "BU_SG_REL_", "BU_EV_REL_", "BU_BO_REL_", "SG_MUL_VAL_"):
        out.append(f"\t{keyword}")
    out.append("")
    out.append("BS_:")
    out.append("")
    out.append("BU_: " + " ".join(layout.nodes))
    out.append("")
    out.append("")

    for msg in layout.messages:
        out.append(f"BO_ {msg.id} {msg.name}: {msg.dlc} {msg.sender}")
        for sig in msg.signals:
            sign = "-" if sig.is_signed else "+"
            unit = dbc_unit(catalog[sig.name].unit)
            receivers = ",".join(msg.receivers) or "Vector__XXX"
            out.append(
                f" SG_ {sig.name} : {sig.start_bit}|{sig.length}@1{sign} "
                f"({fmt_num(sig.scale)},{fmt_num(sig.offset)}) "
                f"[{fmt_num(sig.phys_min)}|{fmt_num(sig.phys_max)}] "
                f'"{unit}" {receivers}'
            )
        out.append("")
    out.append("")

    if layout.comment:
        out.append(f'CM_ "{_dbc_text(layout.comment)}";')
    for node, text in layout.nodes.items():
        out.append(f'CM_ BU_ {node} "{_dbc_text(text)}";')
    for msg in layout.messages:
        text = f"{msg.comment} Cycle {msg.cycle_ms} ms." if msg.comment else f"Cycle {msg.cycle_ms} ms."
        out.append(f'CM_ BO_ {msg.id} "{_dbc_text(text)}";')
        for sig in msg.signals:
            out.append(f'CM_ SG_ {msg.id} {sig.name} "{_signal_comment(sig, catalog)}";')

    out.append('BA_DEF_  "BusType" STRING ;')
    out.append('BA_DEF_  "Baudrate" INT 0 1000000;')
    out.append('BA_DEF_  "DBName" STRING ;')
    out.append('BA_DEF_ BO_  "GenMsgCycleTime" INT 0 65535;')
    out.append('BA_DEF_DEF_  "BusType" "";')
    out.append('BA_DEF_DEF_  "Baudrate" 500000;')
    out.append('BA_DEF_DEF_  "DBName" "";')
    out.append('BA_DEF_DEF_  "GenMsgCycleTime" 0;')
    out.append('BA_ "BusType" "CAN";')
    out.append(f'BA_ "Baudrate" {layout.bitrate};')
    out.append('BA_ "DBName" "AeroVolt";')
    for msg in layout.messages:
        out.append(f'BA_ "GenMsgCycleTime" BO_ {msg.id} {msg.cycle_ms};')

    for msg in layout.messages:
        for sig in msg.signals:
            entries = _value_table(sig, catalog)
            if entries:
                body = " ".join(f'{raw} "{label}"' for raw, label in entries)
                out.append(f"VAL_ {msg.id} {sig.name} {body} ;")
    out.append("")
    return "\n".join(out)


# --------------------------------------------------------------------------------------
# C++ header
# --------------------------------------------------------------------------------------


def _c_double(x: float) -> str:
    """C++ double literal; Python's repr is the shortest round-tripping form (0.1, 1e-07)."""
    return repr(float(x))


def _c_ident(msg: CanMessage) -> str:
    return msg.name.upper()


def render_header(layout: CanLayout) -> str:
    """Render ``aerovolt_can.h`` (header-only C++17, AVR-friendly C headers)."""
    lines: list[str] = []
    w = lines.append
    w("// " + "=" * 86)
    w("// GENERATED - DO NOT EDIT.")
    w("// Source: config/can_layout.yaml   Generator: tools/gen_can.py   (python tools/gen_can.py)")
    w(f"// AeroVolt {__version__} CAN layout: classic CAN 2.0A, 11-bit IDs, "
      f"{layout.bitrate // 1000} kbit/s, Intel byte order, DLC 8.")
    w("//")
    w("// physical = raw * scale + offset")
    w("// raw      = nearbyint((physical - offset) / scale)   // round half to EVEN, exactly like")
    w("//            cantools / Python round(); then clamp to the valid raw range (SNA excluded).")
    w("// SNA (signal not available): signed -> most negative raw (0x80..0), unsigned -> all ones.")
    w("// 1-bit flags have no SNA. Unused bits are 0. Signed values are two's complement.")
    w("// " + "=" * 86)
    w("#pragma once")
    w("")
    w("#include <stddef.h>")
    w("#include <stdint.h>")
    w("")
    w("namespace aerovolt {")
    w("namespace can {")
    w("")
    w(f"constexpr uint32_t BITRATE = {layout.bitrate}u;")
    w("")
    w("struct SignalDef {")
    w("    const char* name;   // == AeroVolt channel id")
    w("    uint8_t start_bit;  // Intel (little-endian) start bit, LSB first")
    w("    uint8_t length;     // bits")
    w("    bool is_signed;     // two's complement")
    w("    double scale;       // physical = raw * scale + offset")
    w("    double offset;")
    w("    bool has_sna;       // false only for 1-bit flags")
    w("};")
    w("")
    w("struct MessageDef {")
    w("    uint32_t id;        // 11-bit identifier")
    w("    const char* name;")
    w("    uint8_t dlc;")
    w("    uint16_t cycle_ms;  // transmit period")
    w("    const SignalDef* signals;")
    w("    uint8_t signal_count;")
    w("};")
    w("")
    w("// ---- Message identifiers " + "-" * 60)
    for msg in layout.messages:
        w(f"constexpr uint32_t ID_{_c_ident(msg)} = 0x{msg.id:03X};")
    w("")
    w("// ---- Signal tables " + "-" * 66)
    for msg in layout.messages:
        w(f"// 0x{msg.id:03X} {msg.name}: {msg.comment}")
        w(f"constexpr SignalDef SIGNALS_{_c_ident(msg)}[] = {{")
        for sig in msg.signals:
            w(f'    {{"{sig.name}", {sig.start_bit}, {sig.length}, '
              f'{"true" if sig.is_signed else "false"}, {_c_double(sig.scale)}, '
              f'{_c_double(sig.offset)}, {"true" if sig.has_sna else "false"}}},')
        w("};")
    w("")
    w("// ---- Message tables " + "-" * 65)
    for msg in layout.messages:
        ident = _c_ident(msg)
        w(f'constexpr MessageDef MSG_{ident} = {{ID_{ident}, "{msg.name}", {msg.dlc}, '
          f"{msg.cycle_ms}, SIGNALS_{ident}, {len(msg.signals)}}};")
    w("")
    w("constexpr MessageDef MESSAGES[] = {")
    for msg in layout.messages:
        w(f"    MSG_{_c_ident(msg)},")
    w("};")
    w(f"constexpr size_t MESSAGE_COUNT = {len(layout.messages)};")
    w(f"constexpr size_t SIGNAL_COUNT = {len(layout.signal_names())};")
    w('static_assert(sizeof(MESSAGES) / sizeof(MESSAGES[0]) == MESSAGE_COUNT, "message table size");')
    w("")
    w("// ---- Helpers " + "-" * 72)
    w("")
    w("/// Raw SNA code of a signal (only meaningful when has_sna).")
    w("constexpr int64_t sna_raw(const SignalDef& s) {")
    w("    return s.is_signed ? -(int64_t(1) << (s.length - 1)) : (int64_t(1) << s.length) - 1;")
    w("}")
    w("")
    w("/// Smallest raw value that encodes a valid reading.")
    w("constexpr int64_t raw_min(const SignalDef& s) {")
    w("    return s.is_signed ? -(int64_t(1) << (s.length - 1)) + (s.has_sna ? 1 : 0) : 0;")
    w("}")
    w("")
    w("/// Largest raw value that encodes a valid reading.")
    w("constexpr int64_t raw_max(const SignalDef& s) {")
    w("    return s.is_signed ? (int64_t(1) << (s.length - 1)) - 1")
    w("                       : (int64_t(1) << s.length) - 1 - (s.has_sna ? 1 : 0);")
    w("}")
    w("")
    w("/// True if a decoded (sign-extended) raw value is the SNA code.")
    w("constexpr bool is_sna(const SignalDef& s, int64_t raw) {")
    w("    return s.has_sna && raw == sna_raw(s);")
    w("}")
    w("")
    w("constexpr bool str_equal(const char* a, const char* b) {")
    w("    return (*a == *b) && (*a == '\\0' || str_equal(a + 1, b + 1));")
    w("}")
    w("")
    w("/// Message with the given CAN id, or nullptr.")
    w("constexpr const MessageDef* find_message(uint32_t id) {")
    w("    for (size_t i = 0; i < MESSAGE_COUNT; ++i) {")
    w("        if (MESSAGES[i].id == id) return &MESSAGES[i];")
    w("    }")
    w("    return nullptr;")
    w("}")
    w("")
    w("/// Message with the given name (e.g. \"AERO_FW_TAPS_A\"), or nullptr.")
    w("constexpr const MessageDef* find_message_by_name(const char* name) {")
    w("    for (size_t i = 0; i < MESSAGE_COUNT; ++i) {")
    w("        if (str_equal(MESSAGES[i].name, name)) return &MESSAGES[i];")
    w("    }")
    w("    return nullptr;")
    w("}")
    w("")
    w("/// Signal of a message by channel id, or nullptr.")
    w("constexpr const SignalDef* find_signal(const MessageDef& msg, const char* channel) {")
    w("    for (uint8_t i = 0; i < msg.signal_count; ++i) {")
    w("        if (str_equal(msg.signals[i].name, channel)) return &msg.signals[i];")
    w("    }")
    w("    return nullptr;")
    w("}")
    w("")
    w("/// Where a channel lives on the bus.")
    w("struct SignalRef {")
    w("    const MessageDef* message;")
    w("    const SignalDef* signal;")
    w("    uint8_t index;  // position of the signal inside the message")
    w("};")
    w("")
    w("/// Look a channel id up across all messages; {nullptr, nullptr, 0} if unknown.")
    w("constexpr SignalRef find_channel(const char* channel) {")
    w("    for (size_t m = 0; m < MESSAGE_COUNT; ++m) {")
    w("        for (uint8_t i = 0; i < MESSAGES[m].signal_count; ++i) {")
    w("            if (str_equal(MESSAGES[m].signals[i].name, channel)) {")
    w("                return SignalRef{&MESSAGES[m], &MESSAGES[m].signals[i], i};")
    w("            }")
    w("        }")
    w("    }")
    w("    return SignalRef{nullptr, nullptr, 0};")
    w("}")
    w("")
    w('static_assert(find_message(ID_AERO_FW_TAPS_A)->id == ID_AERO_FW_TAPS_A, "lookup by id");')
    w('static_assert(find_channel("fw_p03").index == 2, "lookup by channel");')
    w("")
    w("}  // namespace can")
    w("}  // namespace aerovolt")
    w("")
    return "\n".join(lines)


# --------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------


def generate(layout_path: Path = LAYOUT_PATH, sensors_path: Path = SENSORS_PATH) -> dict[Path, bytes]:
    """Render both outputs in memory: {output path: file bytes}."""
    layout = load_can_layout(layout_path)
    catalog = Catalog.load(sensors_path)
    missing = [name for name in layout.signal_names() if name not in catalog]
    if missing:
        raise SystemExit(f"CAN signals without a catalogue channel: {missing}")
    return {
        DBC_PATH: render_dbc(layout, catalog).encode(DBC_ENCODING),
        HEADER_PATH: render_header(layout).encode("utf-8"),
    }


def _display(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--check", action="store_true",
                        help="do not write; exit 1 if the generated files are missing or stale")
    args = parser.parse_args(argv)

    outputs = generate()
    stale = [p for p, data in outputs.items() if not p.exists() or p.read_bytes() != data]
    if args.check:
        for path in stale:
            print(f"STALE: {_display(path)} (run: python tools/gen_can.py)")
        if not stale:
            print("CAN outputs are up to date.")
        return 1 if stale else 0
    for path, data in outputs.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        print(f"wrote {_display(path)} ({len(data)} bytes)")
    layout = load_can_layout(LAYOUT_PATH)
    print(f"{len(layout.messages)} messages, {len(layout.signal_names())} signals, "
          f"estimated bus load {100 * layout.bus_load():.1f} % at {layout.bitrate // 1000} kbit/s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
