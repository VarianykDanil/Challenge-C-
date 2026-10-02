"""Tests for aerovolt.core.geo — local tangent-plane conversion and compass headings."""

import math

import numpy as np
import pytest

from aerovolt.core import geo

ORIGIN = {"lat": 52.0786, "lon": -1.0169}  # gps_origin in config/vehicle.yaml


def test_round_trip_below_one_centimetre_over_two_km():
    xs, ys = np.meshgrid(np.linspace(-2000, 2000, 41), np.linspace(-2000, 2000, 41))
    lat, lon = geo.xy_to_latlon(xs, ys, ORIGIN)
    x2, y2 = geo.latlon_to_xy(lat, lon, ORIGIN)
    err = np.hypot(x2 - xs, y2 - ys)
    assert err.max() < 0.01


def test_latlon_round_trip_from_gps_side():
    lat = ORIGIN["lat"] + np.array([-0.015, 0.0, 0.012])
    lon = ORIGIN["lon"] + np.array([0.02, -0.025, 0.0])
    x, y = geo.latlon_to_xy(lat, lon, ORIGIN)
    lat2, lon2 = geo.xy_to_latlon(x, y, ORIGIN)
    assert np.allclose(lat2, lat, atol=1e-10) and np.allclose(lon2, lon, atol=1e-10)


def test_metres_per_degree_matches_wgs84_series():
    """Compare with the standard series expansion for WGS-84 degree lengths."""
    phi = math.radians(ORIGIN["lat"])
    lat_ref = 111132.92 - 559.82 * math.cos(2 * phi) + 1.175 * math.cos(4 * phi)
    lon_ref = 111412.84 * math.cos(phi) - 93.5 * math.cos(3 * phi) + 0.118 * math.cos(5 * phi)
    m_lat, m_lon = geo.metres_per_degree(ORIGIN["lat"])
    assert m_lat == pytest.approx(lat_ref, abs=1.0)
    assert m_lon == pytest.approx(lon_ref, abs=1.0)


def test_axes_point_east_and_north():
    lat, lon = geo.xy_to_latlon(100.0, 0.0, ORIGIN)
    assert lat == pytest.approx(ORIGIN["lat"]) and lon > ORIGIN["lon"]  # +x = east
    lat, lon = geo.xy_to_latlon(0.0, 100.0, ORIGIN)
    assert lat > ORIGIN["lat"] and lon == pytest.approx(ORIGIN["lon"])  # +y = north


def test_distance_agrees_with_haversine_within_half_a_percent():
    """1 km in each direction: the flat-plane distance vs a spherical great circle."""
    r_earth = 6371008.8
    for x, y in [(1000.0, 0.0), (0.0, 1000.0), (707.0, -707.0)]:
        lat, lon = geo.xy_to_latlon(x, y, ORIGIN)
        p1, p2 = math.radians(ORIGIN["lat"]), math.radians(lat)
        dlat, dlon = p2 - p1, math.radians(lon - ORIGIN["lon"])
        a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
        d = 2 * r_earth * math.asin(math.sqrt(a))
        assert d == pytest.approx(math.hypot(x, y), rel=5e-3)


def test_origin_accepts_tuple_and_scalar_types():
    lat, lon = geo.xy_to_latlon(10.0, 20.0, (ORIGIN["lat"], ORIGIN["lon"]))
    assert isinstance(lat, float) and isinstance(lon, float)
    x, y = geo.latlon_to_xy(lat, lon, ORIGIN)
    assert x == pytest.approx(10.0, abs=1e-6) and y == pytest.approx(20.0, abs=1e-6)


@pytest.mark.parametrize(
    "dx, dy, expected",
    [(0, 1, 0.0), (1, 0, 90.0), (0, -1, 180.0), (-1, 0, 270.0), (1, 1, 45.0), (-1, 1, 315.0)],
)
def test_heading_compass_convention(dx, dy, expected):
    assert geo.heading_deg(dx, dy) == pytest.approx(expected)


def test_heading_vectorised_and_wrapped():
    h = geo.heading_deg(np.array([0.0, -1e-18, 1.0]), np.array([1.0, 1.0, 0.0]))
    assert h.shape == (3,)
    assert np.all((h >= 0.0) & (h < 360.0))
    assert h[1] == pytest.approx(0.0, abs=1e-9)
