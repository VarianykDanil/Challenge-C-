"""Local tangent-plane conversion between GPS coordinates and the flat *track frame*.

Track frame
-----------
A Formula Student venue is a few hundred metres across, so the Earth can be treated as flat
around a fixed *origin* (``gps_origin`` in ``config/vehicle.yaml``). The **track frame** is
the local East-North plane through that origin::

    x = metres east of the origin
    y = metres north of the origin

(this is *not* the ISO 8855 vehicle frame used for the car itself).

Projection: local equirectangular on the WGS-84 ellipsoid
---------------------------------------------------------
Near latitude φ0 one degree of latitude and one degree of longitude correspond to fixed
distances given by the two principal radii of curvature of the ellipsoid::

    M(φ0) = a (1 − e²) / (1 − e² sin²φ0)^(3/2)     meridional radius (north–south)
    N(φ0) = a / (1 − e² sin²φ0)^(1/2)              prime-vertical radius (east–west)

    x = (λ − λ0) · N · cos φ0            (λ = longitude, radians)
    y = (φ − φ0) · M                     (φ = latitude,  radians)

The mapping is linear, so the inverse is exact (round-trip error is floating-point noise).
Its *distortion* (the difference from true geodesic positions) comes mainly from the
meridians converging: the east-west scale changes by ``tan φ0 / R`` per metre north, so the
error is ≈ ``x·y·tan φ0 / R`` — about 2 cm at a 300 m × 300 m FS venue at 52° N and
0.2 m at 1 km × 1 km. That is far below GPS noise (≈ 1–2 m for a standard receiver).

Heading convention
------------------
``heading_deg`` follows navigation/GPS practice: 0° = north (+y), 90° = east (+x),
measured **clockwise**, range [0, 360).
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from typing import Union

import numpy as np

#: WGS-84 semi-major axis [m].
WGS84_A_M = 6378137.0
#: WGS-84 first eccentricity squared [-].
WGS84_E2 = 6.69437999014e-3

ArrayLike = Union[float, np.ndarray]
#: Origin as ``{"lat": deg, "lon": deg}`` (as in vehicle.yaml) or a ``(lat, lon)`` pair.
Origin = Union[Mapping[str, float], Sequence[float]]


def origin_lat_lon(origin: Origin) -> tuple[float, float]:
    """Return ``(lat_deg, lon_deg)`` from a mapping ``{lat, lon}`` or a ``(lat, lon)`` pair."""
    if isinstance(origin, Mapping):
        return float(origin["lat"]), float(origin["lon"])
    lat, lon = origin
    return float(lat), float(lon)


def metres_per_degree(lat_deg: float) -> tuple[float, float]:
    """Metres per degree of (latitude, longitude) at latitude ``lat_deg``.

    Uses the WGS-84 radii of curvature (see module docstring):
    ``m_per_deg_lat = M·π/180`` and ``m_per_deg_lon = N·cos φ·π/180``.
    At 52° N this gives ≈ 111 260 m and ≈ 68 690 m.
    """
    phi = math.radians(lat_deg)
    w = 1.0 - WGS84_E2 * math.sin(phi) ** 2
    meridional = WGS84_A_M * (1.0 - WGS84_E2) / w ** 1.5
    prime_vertical = WGS84_A_M / math.sqrt(w)
    deg = math.pi / 180.0
    return meridional * deg, prime_vertical * math.cos(phi) * deg


def latlon_to_xy(lat: ArrayLike, lon: ArrayLike, origin: Origin) -> tuple[ArrayLike, ArrayLike]:
    """Convert latitude/longitude [deg] to track-frame ``(x east, y north)`` [m].

    Works element-wise on floats or numpy arrays.
    """
    lat0, lon0 = origin_lat_lon(origin)
    m_lat, m_lon = metres_per_degree(lat0)
    x = (np.asarray(lon, dtype=float) - lon0) * m_lon
    y = (np.asarray(lat, dtype=float) - lat0) * m_lat
    if np.ndim(x) == 0:
        return float(x), float(y)
    return x, y


def xy_to_latlon(x: ArrayLike, y: ArrayLike, origin: Origin) -> tuple[ArrayLike, ArrayLike]:
    """Convert track-frame ``(x east, y north)`` [m] to ``(lat, lon)`` [deg].

    Exact inverse of :func:`latlon_to_xy`. Works element-wise on floats or numpy arrays.
    """
    lat0, lon0 = origin_lat_lon(origin)
    m_lat, m_lon = metres_per_degree(lat0)
    lat = lat0 + np.asarray(y, dtype=float) / m_lat
    lon = lon0 + np.asarray(x, dtype=float) / m_lon
    if np.ndim(lat) == 0:
        return float(lat), float(lon)
    return lat, lon


def heading_deg(dx: ArrayLike, dy: ArrayLike) -> ArrayLike:
    """Compass heading [deg] of a displacement ``(dx east, dy north)``.

    ``heading = atan2(dx, dy)`` — note the swapped arguments compared with the maths angle
    ``atan2(dy, dx)``: 0° = north (+y), 90° = east (+x), clockwise, wrapped to [0, 360).
    """
    h = np.degrees(np.arctan2(np.asarray(dx, dtype=float), np.asarray(dy, dtype=float))) % 360.0
    h = np.where(h >= 360.0, 0.0, h)  # a tiny negative angle rounds up to exactly 360.0
    if np.ndim(h) == 0:
        return float(h)
    return h
