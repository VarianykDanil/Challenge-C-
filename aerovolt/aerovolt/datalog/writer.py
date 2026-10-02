"""Data logger: one wide CSV row per store snapshot + a JSON metadata sidecar (SPEC section 8).

File format (``.csv``, or gzip-compressed when the name ends in ``.gz``)::

    t,fw_p01,fw_p02,...,calc_lap_dist          <- header: session time + channel ids
    #units,s,Pa,Pa,...,m                        <- second header line: units
    0.050,-512.3,-498.7,...,12.4                <- one row per snapshot (20 Hz)
    0.100,,-499.1,...,13.1                      <- empty cell = no valid value (NaN)

Why "wide" (one column per channel) rather than "long" (time, channel, value): every
spreadsheet, MATLAB ``readtable`` and pandas ``read_csv`` opens it directly, rows are
aligned in time (each row is the same instant for every channel, sample-and-hold like a
motorsport logger), and gzip compresses the repetitive text about 5-10×.

Numbers are written with the channel's resolution plus one guard digit (a 0.1 Pa tap ->
2 decimals, a 1 mV cell -> 4), so the file is no bigger than the information in it.

The **metadata sidecar** ``<log name without .csv/.csv.gz>.meta.json`` (e.g.
``logs/run1.csv.gz`` -> ``logs/run1.meta.json``) describes the session: config, vehicle,
track, start/end time, sources, faults timeline, alerts, laps and strategy. The session
updates it when a lap completes and when the log is closed, and it is written atomically
(temporary file + rename), so it is always valid JSON even if the program is killed.
"""

from __future__ import annotations

import gzip
import json
import math
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence, TextIO

import numpy as np

from aerovolt.core.model import ChannelDef, _json_any, decimals_for_resolution

#: Identifies the sidecar format.
META_FORMAT = "aerovolt-log"
META_VERSION = 1
#: Units-line marker (first cell of the second header line).
UNITS_MARKER = "#units"
#: Data is flushed to disk at least this often (wall clock), s.
FLUSH_INTERVAL_S = 1.0


def meta_path_for(log_path: str | Path) -> Path:
    """Sidecar path: ``run1.csv.gz`` / ``run1.csv`` -> ``run1.meta.json``."""
    p = Path(log_path)
    name = p.name
    for suffix in (".gz", ".csv"):
        if name.lower().endswith(suffix):
            name = name[: -len(suffix)]
    return p.with_name(name + ".meta.json")


def open_text(path: str | Path, mode: str) -> TextIO:
    """Open a ``.csv`` or ``.csv.gz`` file as UTF-8 text (``mode`` ``'r'`` or ``'w'``)."""
    p = Path(path)
    if p.name.lower().endswith(".gz"):
        return gzip.open(p, mode + "t", encoding="utf-8", newline="")  # type: ignore[return-value]
    return open(p, mode, encoding="utf-8", newline="")


def write_json_atomic(path: Path, data: Any) -> None:
    """Write JSON so readers never see a half-written file (write temp, then rename)."""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(_json_any(data), indent=2, allow_nan=False), encoding="utf-8")
    os.replace(tmp, path)


def column_format(resolution: float) -> str:
    """``%``-format for a channel: resolution + one guard digit, else 7 significant figures."""
    places = decimals_for_resolution(resolution)
    return f"%.{places}f" if places >= 0 else "%.7g"


class LogWriter:
    """Writes the wide CSV log and its metadata sidecar (see the module docstring).

    ``channels`` are catalogue :class:`ChannelDef` objects (column order = their order).
    Use as a context manager or call :meth:`close`.
    """

    def __init__(self, path: str | Path, channels: Sequence[ChannelDef],
                 meta: Mapping[str, Any] | None = None, *, flush_interval_s: float = FLUSH_INTERVAL_S) -> None:
        self.path = Path(path)
        self.meta_path = meta_path_for(self.path)
        self.ids = [ch.id for ch in channels]
        self.units = [ch.unit.replace(",", ";") or "-" for ch in channels]
        self._formats = [column_format(ch.resolution) for ch in channels]
        self.flush_interval_s = float(flush_interval_s)
        self.rows = 0
        self.t_first = math.nan
        self.t_last = math.nan
        self.closed = False
        self.meta: dict[str, Any] = {
            "format": META_FORMAT,
            "format_version": META_VERSION,
            "log_file": self.path.name,
            "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            **dict(meta or {}),
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._fh: TextIO = open_text(self.path, "w")
        self._fh.write("t," + ",".join(self.ids) + "\n")
        self._fh.write(UNITS_MARKER + ",s," + ",".join(self.units) + "\n")
        self._last_flush = time.monotonic()
        self.write_meta()

    # ------------------------------------------------------------------ data

    def write_row(self, t: float, values: Sequence[float] | np.ndarray) -> None:
        """Append one row: ``values`` in column order (NaN / inf -> empty cell)."""
        if self.closed:
            raise ValueError("log is closed")
        if len(values) != len(self.ids):
            raise ValueError(f"row has {len(values)} values, expected {len(self.ids)}")
        row = values.tolist() if isinstance(values, np.ndarray) else values
        # ``v - v == 0`` is False for NaN and +-inf: a fast "is finite" for a hot loop.
        cells = [fmt % v if v - v == 0 else "" for fmt, v in zip(self._formats, row)]
        self._fh.write(f"{t:.3f}," + ",".join(cells) + "\n")
        self.rows += 1
        if self.rows == 1:
            self.t_first = float(t)
        self.t_last = float(t)
        now = time.monotonic()
        if now - self._last_flush >= self.flush_interval_s:
            self._fh.flush()
            self._last_flush = now

    def write_values(self, t: float, values: Mapping[str, float]) -> None:
        """Append one row from a ``{channel: value}`` dict (missing channels -> empty)."""
        nan = math.nan
        self.write_row(t, [float(values.get(cid, nan)) for cid in self.ids])

    # ------------------------------------------------------------------ metadata

    def update_meta(self, **fields: Any) -> None:
        """Merge ``fields`` into the sidecar and rewrite it (atomically)."""
        self.meta.update(fields)
        self.write_meta()

    def write_meta(self) -> None:
        stats = {
            "rows": self.rows,
            "columns": len(self.ids),
            "t_first": None if math.isnan(self.t_first) else round(self.t_first, 3),
            "t_last": None if math.isnan(self.t_last) else round(self.t_last, 3),
        }
        write_json_atomic(self.meta_path, {**self.meta, **stats})

    # ------------------------------------------------------------------ lifecycle

    def flush(self) -> None:
        if not self.closed:
            self._fh.flush()

    def close(self, **final_meta: Any) -> None:
        """Finish the file and write the final metadata (``ended`` time added)."""
        if self.closed:
            return
        self._fh.close()
        self.closed = True
        self.meta["ended"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        self.update_meta(**final_meta)

    def __enter__(self) -> LogWriter:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


def write_log(path: str | Path, channels: Sequence[ChannelDef], t: Iterable[float],
              rows: Iterable[Sequence[float]], meta: Mapping[str, Any] | None = None) -> Path:
    """Write a whole log in one call (tools and tests)."""
    with LogWriter(path, channels, meta) as writer:
        for ti, row in zip(t, rows):
            writer.write_row(ti, row)
    return writer.path


__all__ = ["LogWriter", "meta_path_for", "open_text", "write_json_atomic", "write_log",
           "UNITS_MARKER", "META_FORMAT", "META_VERSION", "column_format"]
