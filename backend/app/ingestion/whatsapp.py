"""WhatsApp ingestion adapter (Twilio-style payload).

Design constraints from the brief:
  * The reporter is a BYSTANDER, not the victim.
  * ZERO typing required: a report completes via a tap (quick-reply keyword),
    a photo, or a voice note.
  * Location arrives via WhatsApp location-share (Latitude/Longitude fields)
    or EXIF; we accept whatever the payload carries.

This adapter only NORMALIZES. It calls the bounded AI extraction layer to turn
media into structured facts, then returns a NormalizedReport. It makes no
verdict.
"""
from __future__ import annotations

from ..ai.extractor import extract_from_media
from ..models import ExtractedFacts, NormalizedReport
from .base import IngestionAdapter

TRIGGER_KEYWORDS = {"report hazard", "report", "flood", "🚨", "help", "sos"}


class WhatsAppAdapter(IngestionAdapter):
    channel = "whatsapp"

    def is_trigger(self, body: str) -> bool:
        """A single persistent trigger: fixed keyword or quick-reply button."""
        return (body or "").strip().lower() in TRIGGER_KEYWORDS

    def normalize(self, raw: dict) -> NormalizedReport:
        # Twilio WhatsApp webhook fields (subset).
        sender = raw.get("From") or raw.get("WaId")
        lat = _to_float(raw.get("Latitude"))
        lon = _to_float(raw.get("Longitude"))
        body = raw.get("Body", "")
        num_media = int(raw.get("NumMedia", 0) or 0)

        media_kind = "none"
        media_uri = None
        facts = ExtractedFacts(source="text")

        if num_media > 0:
            media_uri = raw.get("MediaUrl0")
            content_type = raw.get("MediaContentType0", "")
            if content_type.startswith("image/"):
                media_kind = "photo"
            elif content_type.startswith("audio/"):
                media_kind = "voice"
            else:
                media_kind = "photo"
            facts = extract_from_media(media_kind, media_uri, hint_text=body)
        elif body and not self.is_trigger(body):
            # Bystander typed a landmark on the fallback path -- still allowed,
            # but the primary path never requires it.
            media_kind = "text"
            facts = extract_from_media("text", None, hint_text=body)

        landmark = facts.extracted_location_text or (body if media_kind == "text" else None)

        return NormalizedReport(
            channel=self.channel,
            reporter_ref=sender,
            lat=lat,
            lon=lon,
            landmark=landmark,
            media_kind=media_kind,
            media_uri=media_uri,
            facts=facts,
        )


def _to_float(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None
