"""ChannelStore: latest value of every channel plus a fixed-size history (SPEC section 4).

Two views of the data:

* **Latest** - ``update(t, values)`` records each channel's newest value and the time it
  arrived. ``latest``/``latest_all``/``age``/``status`` answer "what is the car doing now?".
* **History** - ``snapshot(t)`` copies the latest value of *every* catalogue channel into
  one row of a numpy ring buffer (rows = snapshots, columns = catalogue channels, float64).
  Called at ``snapshot_hz`` (20 Hz) by the session; ``history(ids, seconds)`` returns the
  last ``seconds`` as arrays for plots and the REST API.

Ring buffer: a preallocated ``(capacity, n_channels)`` array and a write index that wraps
around, so appending is O(1) (one row copy, no allocation) and memory is bounded:
300 s x 20 Hz x ~400 channels x 8 bytes ~ 19 MB. Reading the last N rows is at most two
contiguous slices. Snapshots hold the last received value (sample-and-hold, like a
motorsport data logger); channels never received are NaN.
"""

from __future__ import annotations

import math
from typing import Iterable, Mapping

import numpy as np

from .catalog import Catalog

NAN = float("nan")

#: Minimum time without an update before a channel is called stale, s.
STALE_MIN_S = 0.5
#: A channel is stale after missing this many of its nominal samples.
STALE_SAMPLES = 5.0
#: Assumed rate for channels that are not in the catalogue, Hz.
DEFAULT_RATE_HZ = 1.0


class ChannelStore:
    """Latest values + numpy ring-buffer history of all catalogue channels."""

    def __init__(self, catalog: Catalog, history_s: float = 300.0, snapshot_hz: float = 20.0) -> None:
        self.catalog = catalog
        self.history_s = float(history_s)
        self.snapshot_hz = float(snapshot_hz)
        self.ids: list[str] = [ch.id for ch in catalog]
        self._col: dict[str, int] = {cid: i for i, cid in enumerate(self.ids)}
        self._stale_after: dict[str, float] = {
            ch.id: max(STALE_MIN_S, STALE_SAMPLES / ch.rate_hz) for ch in catalog
        }
        self.capacity = int(math.ceil(self.history_s * self.snapshot_hz)) + 1
        self._buf = np.full((self.capacity, len(self.ids)), NAN, dtype=np.float64)
        self._buf_t = np.full(self.capacity, NAN, dtype=np.float64)
        self.reset()

    # ---- latest values ----------------------------------------------------------------

    def reset(self) -> None:
        """Forget everything (new session)."""
        self._latest: dict[str, float] = {}
        self._stamp: dict[str, float] = {}
        self._row = np.full(len(self.ids), NAN, dtype=np.float64)
        self._buf.fill(NAN)
        self._buf_t.fill(NAN)
        self._head = 0  # next row to write
        self._count = 0  # rows filled (<= capacity)
        self.t = NAN  # time of the latest update or snapshot

    def update(self, t: float, values: Mapping[str, float]) -> None:
        """Record new values (channel id -> value) received at session time ``t``.

        Channels outside the catalogue are kept in the latest-value view (so nothing is
        silently lost) but have no history column.
        """
        col = self._col
        row = self._row
        for cid, value in values.items():
            v = float(value) if value is not None else NAN
            self._latest[cid] = v
            self._stamp[cid] = t
            i = col.get(cid)
            if i is not None:
                row[i] = v
        if not t <= self.t:  # also true while self.t is NaN
            self.t = t

    def latest(self, cid: str) -> float:
        """Newest value of a channel, NaN if never received."""
        return self._latest.get(cid, NAN)

    def latest_all(self) -> dict[str, float]:
        """Copy of all newest values ``{id: value}`` (only channels received so far)."""
        return dict(self._latest)

    def timestamp(self, cid: str) -> float:
        """Session time of the newest value, NaN if never received."""
        return self._stamp.get(cid, NAN)

    def age(self, cid: str, now: float) -> float:
        """Seconds since the channel was last updated (``inf`` if never)."""
        stamp = self._stamp.get(cid)
        return math.inf if stamp is None else now - stamp

    def stale_after(self, cid: str) -> float:
        """Silence (s) after which a channel counts as stale: ``max(0.5, 5 / rate_hz)``."""
        return self._stale_after.get(cid, max(STALE_MIN_S, STALE_SAMPLES / DEFAULT_RATE_HZ))

    def status(self, cid: str, now: float) -> str:
        """``'live'``, ``'stale'`` (no update for more than ``max(0.5, 5/rate_hz)`` s) or
        ``'missing'`` (never received)."""
        stamp = self._stamp.get(cid)
        if stamp is None:
            return "missing"
        return "stale" if now - stamp > self.stale_after(cid) else "live"

    def statuses(self, now: float, ids: Iterable[str] | None = None) -> dict[str, str]:
        """:meth:`status` for many channels at once (default: all catalogue channels)."""
        return {cid: self.status(cid, now) for cid in (self.ids if ids is None else ids)}

    # ---- history ----------------------------------------------------------------------

    def snapshot(self, t: float) -> None:
        """Append one row (latest value of every catalogue channel) at time ``t``. O(1)."""
        self._buf[self._head] = self._row
        self._buf_t[self._head] = t
        self._head = (self._head + 1) % self.capacity
        self._count = min(self._count + 1, self.capacity)
        if not t <= self.t:
            self.t = t

    def __len__(self) -> int:
        """Number of snapshots held."""
        return self._count

    def _last_rows(self, n: int) -> tuple[np.ndarray, np.ndarray]:
        """Row indices (chronological) of the newest ``n`` snapshots -> (t, row index)."""
        n = min(n, self._count)
        start = (self._head - n) % self.capacity
        if start + n <= self.capacity:
            idx = np.arange(start, start + n)
        else:
            idx = np.concatenate((np.arange(start, self.capacity), np.arange(0, self._head)))
        return self._buf_t[idx], idx

    def history(self, ids: Iterable[str], seconds: float | None = None) -> tuple[np.ndarray, dict[str, np.ndarray]]:
        """Snapshots of the last ``seconds`` (all held snapshots if ``None``).

        Returns ``(t, {id: values})`` with arrays in chronological order (copies, safe to
        keep). Unknown ids give all-NaN arrays.
        """
        if self._count == 0:
            empty = np.empty(0)
            return empty, {cid: empty.copy() for cid in ids}
        if seconds is None:
            n = self._count
        else:
            n = int(math.ceil(max(0.0, float(seconds)) * self.snapshot_hz)) + 1
        t, idx = self._last_rows(n)
        if seconds is not None:
            keep = t >= t[-1] - float(seconds) - 1e-9
            t, idx = t[keep], idx[keep]
        series: dict[str, np.ndarray] = {}
        for cid in ids:
            col = self._col.get(cid)
            series[cid] = self._buf[idx, col] if col is not None else np.full(len(idx), NAN)
        return t.copy(), series

    def history_matrix(self, seconds: float | None = None) -> tuple[np.ndarray, np.ndarray]:
        """All columns at once: ``(t, values[rows, len(self.ids)])`` (for the data logger)."""
        n = self._count if seconds is None else int(math.ceil(seconds * self.snapshot_hz)) + 1
        t, idx = self._last_rows(n)
        return t.copy(), self._buf[idx]
