"""Shared ingestion interface.

Both the WhatsApp adapter and the SMS adapter subclass ``IngestionAdapter`` and
must return a ``NormalizedReport``. This is the architectural seam the brief
requires: two adapters, ONE pipeline. Everything downstream (AI extraction,
rule engine, ledger) operates only on ``NormalizedReport``.
"""
from __future__ import annotations

from abc import ABC, abstractmethod

from ..db import get_conn
from ..models import NormalizedReport


class IngestionAdapter(ABC):
    """Base class for every reporting channel."""

    channel: str

    @abstractmethod
    def normalize(self, raw: dict) -> NormalizedReport:
        """Convert a channel-specific payload into a NormalizedReport."""
        raise NotImplementedError


def persist_report(report: NormalizedReport) -> None:
    """Store a normalized report. Shared by all adapters."""
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO reports (
                id, channel, reporter_ref, lat, lon, landmark,
                media_kind, media_uri, hazard_type, severity, extracted, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                report.id,
                report.channel,
                report.reporter_ref,
                report.lat,
                report.lon,
                report.landmark,
                report.media_kind,
                report.media_uri,
                report.facts.hazard_type,
                ", ".join(report.facts.severity_indicators),
                report.facts.model_dump_json(),
                report.created_at,
            ),
        )
