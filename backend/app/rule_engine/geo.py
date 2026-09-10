"""Geospatial helpers for the rule engine. Pure functions, no I/O."""
from __future__ import annotations

import math


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two points in kilometres."""
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def centroid(points: list[tuple[float, float]]) -> tuple[float, float]:
    """Simple arithmetic centroid. Fine at city scale for the demo."""
    lat = sum(p[0] for p in points) / len(points)
    lon = sum(p[1] for p in points) / len(points)
    return lat, lon
