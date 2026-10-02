#!/usr/bin/env python3
"""Export an AeroVolt log as a clean, resampled CSV for MATLAB, Excel or Python.

The logger writes one row per 20 Hz snapshot with every channel (~380 columns). For a
report you usually want a few channels, a time window and a fixed sample rate::

    python tools/export_wide.py logs/run1.csv.gz -o laps.csv --rate 10 \\
        --channels "calc_cla,calc_cda,calc_aero_balance,cell_t_*" --start 60 --end 180

Resampling onto the new time grid ``t_k = start + k / rate``:

* **continuous channels** (pressures, temperatures, ...) are linearly interpolated
  between the two neighbouring *valid* samples,
  ``x(t) = x_i + (x_{i+1} - x_i) (t - t_i) / (t_{i+1} - t_i)``;
* **discrete channels** (unit ``enum`` or ``bool``, lap numbers, cell indices) are held
  (zero-order hold: the last value at or before ``t``) - interpolating "inverter state 2.5"
  or "lap 3.4" would be meaningless;
* gaps longer than ``--max-gap`` seconds (a dead sensor) stay empty instead of being
  bridged by a straight line that never happened.

Output: header ``t,<channels>``; ``--units`` adds a second row with the units (MATLAB:
``readtable(f, 'NumHeaderLines', 1)`` then skips it). Missing values are written as empty
cells (``--nan NaN`` writes the text NaN, which MATLAB reads as NaN). A name ending in
``.gz`` is gzip-compressed.
"""

from __future__ import annotations

import argparse
import fnmatch
import sys
from pathlib import Path
from typing import Sequence

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from aerovolt.datalog.reader import LogData, LogReader  # noqa: E402
from aerovolt.datalog.writer import open_text  # noqa: E402

#: Units of channels that must be held, not interpolated.
DISCRETE_UNITS = frozenset({"enum", "bool"})
#: Channel ids (or suffixes) that are counters / indices: held, not interpolated.
DISCRETE_IDS = ("calc_lap", "truth_lap", "_idx")


def select_channels(ids: Sequence[str], patterns: str | None) -> list[str]:
    """Channels matching comma-separated names / shell patterns (``fw_p*``), in log order.

    ``None`` or empty selects every channel. A pattern matching nothing is an error
    (most likely a typo).
    """
    if not patterns:
        return list(ids)
    wanted = [p.strip() for p in patterns.split(",") if p.strip()]
    unmatched = [p for p in wanted if not any(fnmatch.fnmatchcase(cid, p) for cid in ids)]
    if unmatched:
        raise ValueError(f"no channel matches {', '.join(unmatched)}")
    return [cid for cid in ids if any(fnmatch.fnmatchcase(cid, p) for p in wanted)]


def is_discrete(cid: str, unit: str) -> bool:
    """True for channels that are held rather than interpolated."""
    return unit in DISCRETE_UNITS or cid in DISCRETE_IDS or cid.endswith(DISCRETE_IDS[-1])


def resample_series(t: np.ndarray, x: np.ndarray, t_new: np.ndarray, *, hold: bool,
                    max_gap: float) -> np.ndarray:
    """Resample one channel onto ``t_new`` (see the module docstring). NaN = no data."""
    valid = np.isfinite(x)
    out = np.full(len(t_new), np.nan)
    if valid.sum() == 0 or len(t_new) == 0:
        return out
    tv, xv = t[valid], x[valid]
    # Index of the last valid sample at or before each new time (-1 = none yet).
    i_prev = np.searchsorted(tv, t_new, side="right") - 1
    has_prev = i_prev >= 0
    i_prev_c = np.clip(i_prev, 0, len(tv) - 1)
    if hold:
        ok = has_prev & (t_new - tv[i_prev_c] <= max_gap)
        out[ok] = xv[i_prev_c[ok]]
        return out
    i_next = np.clip(i_prev + 1, 0, len(tv) - 1)
    exact = has_prev & (tv[i_prev_c] == t_new)
    inside = has_prev & (i_prev + 1 < len(tv)) & (tv[i_next] - tv[i_prev_c] <= max_gap)
    interp = np.interp(t_new, tv, xv)
    out[inside] = interp[inside]
    out[exact] = xv[i_prev_c[exact]]
    return out


def resample(log: LogData, rate_hz: float, start: float | None = None, end: float | None = None,
             max_gap: float = 0.5) -> tuple[np.ndarray, np.ndarray]:
    """Whole log onto a uniform grid at ``rate_hz``: ``(t_new, values[rows, columns])``."""
    if rate_hz <= 0:
        raise ValueError("rate must be > 0")
    if len(log.t) == 0:
        return np.empty(0), np.empty((0, len(log.ids)))
    t0 = log.t[0] if start is None else max(start, log.t[0])
    t1 = log.t[-1] if end is None else min(end, log.t[-1])
    n = int(np.floor((t1 - t0) * rate_hz + 1e-9)) + 1 if t1 >= t0 else 0
    t_new = t0 + np.arange(n) / rate_hz
    cols = [resample_series(log.t, log.values[:, j], t_new, hold=is_discrete(cid, log.units[j]),
                            max_gap=max_gap) for j, cid in enumerate(log.ids)]
    values = np.column_stack(cols) if cols else np.empty((n, 0))
    return t_new, values


def write_csv(path: Path, t: np.ndarray, ids: Sequence[str], units: Sequence[str] | None,
              values: np.ndarray, nan_text: str = "", digits: int = 7) -> None:
    """Write ``t`` + columns as CSV (``.gz`` -> gzip)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fmt = f"%.{digits}g"
    with open_text(path, "w") as fh:
        fh.write("t," + ",".join(ids) + "\n")
        if units is not None:
            fh.write("s," + ",".join(u or "-" for u in units) + "\n")
        for ti, row in zip(t.tolist(), values.tolist()):
            cells = [fmt % v if v - v == 0 else nan_text for v in row]
            fh.write(f"{ti:.3f}," + ",".join(cells) + "\n")


def export(log_path: str | Path, out_path: str | Path, *, channels: str | None = None,
           rate_hz: float | None = 10.0, start: float | None = None, end: float | None = None,
           max_gap: float = 0.5, units: bool = False, nan_text: str = "") -> tuple[int, int]:
    """Export a log; returns ``(rows, columns)`` written. ``rate_hz=None`` keeps the
    original rows (no resampling)."""
    reader = LogReader(log_path)
    ids = select_channels(reader.ids, channels)
    log = reader.read(ids, start, end)
    if rate_hz is None:
        t, values = log.t, log.values
    else:
        t, values = resample(log, rate_hz, start, end, max_gap)
    write_csv(Path(out_path), t, ids, log.units if units else None, values, nan_text)
    return len(t), len(ids)


def default_output(log_path: Path) -> Path:
    name = log_path.name
    for ext in (".gz", ".csv"):
        if name.lower().endswith(ext):
            name = name[: -len(ext)]
    return log_path.with_name(name + "_export.csv")


def main(argv: Sequence[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Export an AeroVolt log as a resampled CSV (MATLAB / Excel).")
    p.add_argument("log", type=Path, help="log file written by AeroVolt (.csv or .csv.gz)")
    p.add_argument("-o", "--output", type=Path, help="output CSV (default: <log>_export.csv)")
    p.add_argument("--channels", help="comma-separated ids or patterns, e.g. 'calc_cla,fw_p*' (default: all)")
    p.add_argument("--rate", type=float, default=10.0, help="output sample rate, Hz (default 10)")
    p.add_argument("--raw-rows", action="store_true", help="keep the logged rows (no resampling)")
    p.add_argument("--start", type=float, help="start time, s")
    p.add_argument("--end", type=float, help="end time, s")
    p.add_argument("--max-gap", type=float, default=0.5, help="do not bridge gaps longer than this, s")
    p.add_argument("--units", action="store_true", help="add a units row under the header")
    p.add_argument("--nan", default="", help="text for missing values (default: empty cell)")
    args = p.parse_args(argv)
    out = args.output or default_output(args.log)
    try:
        rows, cols = export(args.log, out, channels=args.channels, rate_hz=None if args.raw_rows else args.rate,
                            start=args.start, end=args.end, max_gap=args.max_gap, units=args.units,
                            nan_text=args.nan)
    except (FileNotFoundError, ValueError, KeyError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(f"wrote {rows} rows x {cols} channels to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
