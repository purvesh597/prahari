"""Ambient / corroboration data layer (software-only, API-shaped).

Its ONLY job: flag zones as elevated-risk BEFORE any citizen report arrives, so
citizen reports serve as corroboration rather than sole detection.

For the demo this reads a bundled mock IMD/CWC feed. The public surface
(``get_zone_risk``) is written as if it were a live client so the mock can be
swapped for a real feed with no downstream changes.
"""
from __future__ import annotations

import json
import math
from functools import lru_cache
from typing import Optional

from ..config import AMBIENT_MOCK_FILE

# Radius within which a report is considered "inside" a known ambient zone.
_ZONE_MATCH_KM = 2.0


@lru_cache(maxsize=1)
def _load_feed() -> dict:
    with open(AMBIENT_MOCK_FILE, "r", encoding="utf-8") as fh:
        return json.load(fh)


def all_zones() -> list[dict]:
    return _load_feed().get("zones", [])


def _haversine_km(lat1, lon1, lat2, lon2) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def get_zone_risk(lat: Optional[float], lon: Optional[float]) -> Optional[dict]:
    """Return the ambient risk record for the zone containing (lat, lon).

    Returns None if coordinates are missing or no known zone is nearby.
    """
    if lat is None or lon is None:
        return None
    best = None
    best_d = _ZONE_MATCH_KM
    for z in all_zones():
        d = _haversine_km(lat, lon, z["lat"], z["lon"])
        if d <= best_d:
            best_d = d
            best = z
    return best


def resolve_landmark(text: Optional[str]) -> Optional[dict]:
    """Resolve an SMS landmark string to a zone's coordinates via the gazetteer.

    Lets landmark-only SMS reports still cluster geographically.
    """
    if not text:
        return None
    t = text.lower()
    for z in all_zones():
        for lm in z.get("landmarks", []):
            if lm in t:
                return {"lat": z["lat"], "lon": z["lon"], "zone": z}
    return None
