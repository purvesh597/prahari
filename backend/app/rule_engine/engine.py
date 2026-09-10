"""Deterministic verdict layer.

This module -- NOT an LLM -- decides the confidence tier for each incident.
Every decision is plain, inspectable, testable Python. The AI extraction layer
only supplies facts as input here; it never reaches into this logic.

Pipeline:
  1. cluster_reports(): geo + time single-linkage clustering of reports.
  2. evaluate():        per-cluster confidence tiering with explicit reasons,
                        weighted up/down by corroboration and ambient risk.
"""
from __future__ import annotations

from datetime import datetime

from ..ambient.provider import get_zone_risk
from ..config import (
    CLUSTER_RADIUS_KM,
    CLUSTER_WINDOW_MINUTES,
    TIER_CORROBORATED,
    TIER_HIGH_CONFIDENCE,
    TIER_UNVERIFIED,
)
from ..models import Incident, NormalizedReport
from .geo import centroid, haversine_km


def _parse_ts(ts: str) -> datetime:
    return datetime.fromisoformat(ts)


def cluster_reports(reports: list[NormalizedReport]) -> list[list[NormalizedReport]]:
    """Group reports that fall within CLUSTER_RADIUS_KM and CLUSTER_WINDOW_MINUTES.

    Greedy single-linkage. Reports lacking coordinates cannot be geo-clustered,
    so each becomes its own singleton cluster (it can still be tiered, but never
    gains geographic corroboration).
    """
    geo_reports = [r for r in reports if r.lat is not None and r.lon is not None]
    no_geo = [r for r in reports if r.lat is None or r.lon is None]

    geo_reports.sort(key=lambda r: r.created_at)
    clusters: list[list[NormalizedReport]] = []

    for r in geo_reports:
        placed = False
        r_ts = _parse_ts(r.created_at)
        for cluster in clusters:
            anchor = cluster[0]
            within_space = (
                haversine_km(r.lat, r.lon, anchor.lat, anchor.lon) <= CLUSTER_RADIUS_KM
            )
            within_time = (
                abs((r_ts - _parse_ts(anchor.created_at)).total_seconds())
                <= CLUSTER_WINDOW_MINUTES * 60
            )
            if within_space and within_time:
                cluster.append(r)
                placed = True
                break
        if not placed:
            clusters.append([r])

    clusters.extend([[r] for r in no_geo])
    return clusters


def _tier_for_cluster(cluster: list[NormalizedReport], ambient: dict | None):
    """Return (tier, reasons) for one cluster. Fully deterministic.

    Weighting rules (inspectable):
      UP   - multiple INDEPENDENT reporters clustered in time/space
      UP   - zone already flagged elevated-risk by ambient IMD/CWC data
      UP   - photo-backed facts (stronger evidence than a bare SMS keyword)
      DOWN - a lone report with no corroboration in a zone with no ambient signal
    """
    reasons: list[str] = []

    independent = len({r.reporter_ref or r.id for r in cluster})
    has_photo = any(r.media_kind == "photo" for r in cluster)
    has_media = any(r.media_kind in {"photo", "voice"} for r in cluster)

    ambient_level = (ambient or {}).get("risk_level")
    ambient_elevated = ambient_level == "elevated"
    ambient_watch = ambient_level == "watch"

    if independent >= 2:
        reasons.append(f"{independent} independent reports clustered in time/space")
    if ambient_elevated:
        reasons.append(f"ambient IMD/CWC flag: elevated ({ambient.get('reason')})")
    elif ambient_watch:
        reasons.append(f"ambient IMD/CWC flag: watch ({ambient.get('reason')})")
    if has_photo:
        reasons.append("photo-backed evidence present")
    elif has_media:
        reasons.append("voice-note evidence present")

    # --- Tier decision (order matters; first match wins) ---
    if (independent >= 2 and ambient_elevated) or independent >= 3:
        tier = TIER_HIGH_CONFIDENCE
    elif independent >= 2 or (independent >= 1 and ambient_elevated) or (has_photo and ambient_watch):
        tier = TIER_CORROBORATED
    else:
        tier = TIER_UNVERIFIED
        reasons.append("single uncorroborated report, no ambient risk signal")

    return tier, reasons


def evaluate(reports: list[NormalizedReport]) -> list[Incident]:
    """Cluster + tier all reports into ranked incidents."""
    incidents: list[Incident] = []

    for cluster in cluster_reports(reports):
        geo_pts = [(r.lat, r.lon) for r in cluster if r.lat is not None]
        if geo_pts:
            clat, clon = centroid(geo_pts)
        else:
            clat = clon = 0.0

        ambient = get_zone_risk(clat, clon) if geo_pts else None
        tier, reasons = _tier_for_cluster(cluster, ambient)

        timestamps = sorted(r.created_at for r in cluster)
        incidents.append(
            Incident(
                incident_id=cluster[0].id,
                lat=clat,
                lon=clon,
                zone_name=(ambient or {}).get("zone_name"),
                report_ids=[r.id for r in cluster],
                report_count=len(cluster),
                tier=tier,
                reasons=reasons,
                ambient_flagged=bool(ambient and ambient.get("risk_level") in {"elevated", "watch"}),
                ambient_detail=ambient,
                first_seen=timestamps[0],
                last_seen=timestamps[-1],
            )
        )

    # Rank most severe first for the officer feed.
    order = {TIER_HIGH_CONFIDENCE: 0, TIER_CORROBORATED: 1, TIER_UNVERIFIED: 2}
    incidents.sort(key=lambda i: (order[i.tier], -i.report_count))
    return incidents
