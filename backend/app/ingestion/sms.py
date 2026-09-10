"""SMS fallback ingestion adapter.

Fixed short-code format:  ``FLOOD <landmark or location>``

Covers data-only network shutdowns (SMS usually stays live). It feeds the SAME
pipeline as WhatsApp: it produces a NormalizedReport and nothing more. We try to
resolve the landmark to coordinates via the ambient zone gazetteer so clustering
still works when the phone can't share GPS.
"""
from __future__ import annotations

from ..ambient.provider import resolve_landmark
from ..models import ExtractedFacts, NormalizedReport
from .base import IngestionAdapter


class SMSAdapter(IngestionAdapter):
    channel = "sms"

    def normalize(self, raw: dict) -> NormalizedReport:
        sender = raw.get("From")
        body = (raw.get("Body") or "").strip()

        landmark = None
        parts = body.split(None, 1)
        if parts and parts[0].upper() == "FLOOD":
            landmark = parts[1].strip() if len(parts) > 1 else None
        else:
            landmark = body or None

        lat = lon = None
        resolved = resolve_landmark(landmark) if landmark else None
        if resolved:
            lat, lon = resolved["lat"], resolved["lon"]

        # SMS carries no media; the fact we CAN extract is the hazard keyword.
        facts = ExtractedFacts(
            hazard_type="flood",
            severity_indicators=[],
            extracted_location_text=landmark,
            confidence_of_extraction=0.4,
            source="text",
        )

        return NormalizedReport(
            channel=self.channel,
            reporter_ref=sender,
            lat=lat,
            lon=lon,
            landmark=landmark,
            media_kind="text",
            media_uri=None,
            facts=facts,
        )
