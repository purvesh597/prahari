"""Tests for the deterministic rule engine.

These prove the verdict is deterministic and inspectable -- no LLM involved.
"""
from datetime import datetime, timedelta, timezone

from app.models import ExtractedFacts, NormalizedReport
from app.rule_engine import cluster_reports, evaluate, haversine_km

# Known ambient zones from data/ambient_mock.json
KURLA = (19.0726, 72.8845)      # elevated (river above danger)
ANDHERI = (19.1197, 72.8464)    # watch
COLABA = (18.9067, 72.8147)     # normal


def _report(lat, lon, ref, minutes_ago=0, media="photo", severity=None):
    ts = (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).isoformat()
    return NormalizedReport(
        channel="whatsapp",
        reporter_ref=ref,
        lat=lat,
        lon=lon,
        media_kind=media,
        facts=ExtractedFacts(
            hazard_type="flood",
            severity_indicators=severity or ["visible flooding"],
            confidence_of_extraction=0.85,
        ),
        created_at=ts,
    )


def test_haversine_zero():
    assert haversine_km(19.0, 72.0, 19.0, 72.0) == 0


def test_nearby_reports_cluster_together():
    r1 = _report(KURLA[0], KURLA[1], "a", minutes_ago=5)
    r2 = _report(KURLA[0] + 0.001, KURLA[1] + 0.001, "b", minutes_ago=3)
    clusters = cluster_reports([r1, r2])
    assert len(clusters) == 1
    assert len(clusters[0]) == 2


def test_far_reports_split():
    r1 = _report(KURLA[0], KURLA[1], "a")
    r2 = _report(COLABA[0], COLABA[1], "b")
    clusters = cluster_reports([r1, r2])
    assert len(clusters) == 2


def test_time_window_splits_same_location():
    r1 = _report(KURLA[0], KURLA[1], "a", minutes_ago=0)
    r2 = _report(KURLA[0], KURLA[1], "b", minutes_ago=180)  # 3h apart
    clusters = cluster_reports([r1, r2])
    assert len(clusters) == 2


def test_two_independent_reports_plus_elevated_ambient_is_high_confidence():
    r1 = _report(KURLA[0], KURLA[1], "a", minutes_ago=5)
    r2 = _report(KURLA[0] + 0.001, KURLA[1], "b", minutes_ago=3)
    incidents = evaluate([r1, r2])
    assert len(incidents) == 1
    assert incidents[0].tier == "High-Confidence"
    assert incidents[0].ambient_flagged is True


def test_single_report_no_ambient_is_unverified():
    r1 = _report(COLABA[0], COLABA[1], "a")  # normal ambient zone
    incidents = evaluate([r1])
    assert incidents[0].tier == "Unverified"
    assert any("single uncorroborated" in reason for reason in incidents[0].reasons)


def test_single_report_in_elevated_zone_is_corroborated():
    r1 = _report(KURLA[0], KURLA[1], "a")
    incidents = evaluate([r1])
    assert incidents[0].tier == "Corroborated"


def test_photo_in_watch_zone_is_corroborated():
    r1 = _report(ANDHERI[0], ANDHERI[1], "a", media="photo")
    incidents = evaluate([r1])
    assert incidents[0].tier == "Corroborated"


def test_three_independent_reports_high_confidence_without_ambient():
    # Three reporters clustered in a normal zone -> corroboration alone lifts it.
    r1 = _report(COLABA[0], COLABA[1], "a", minutes_ago=5)
    r2 = _report(COLABA[0] + 0.001, COLABA[1], "b", minutes_ago=4)
    r3 = _report(COLABA[0], COLABA[1] + 0.001, "c", minutes_ago=3)
    incidents = evaluate([r1, r2, r3])
    assert incidents[0].tier == "High-Confidence"


def test_same_reporter_twice_is_not_corroboration():
    # One person reporting twice must NOT count as independent corroboration.
    r1 = _report(COLABA[0], COLABA[1], "same", minutes_ago=5)
    r2 = _report(COLABA[0] + 0.001, COLABA[1], "same", minutes_ago=3)
    incidents = evaluate([r1, r2])
    assert incidents[0].tier == "Unverified"


def test_ranking_puts_high_confidence_first():
    high = [
        _report(KURLA[0], KURLA[1], "a", minutes_ago=5),
        _report(KURLA[0] + 0.001, KURLA[1], "b", minutes_ago=4),
    ]
    unverified = [_report(COLABA[0], COLABA[1], "c")]
    incidents = evaluate(high + unverified)
    assert incidents[0].tier == "High-Confidence"
    assert incidents[-1].tier == "Unverified"
