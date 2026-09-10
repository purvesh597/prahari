"""Demo seeding: load bundled sample reports through the real adapters.

Uses the WhatsApp / SMS adapters so seeded data flows through the exact same
normalization + extraction path as live traffic.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from .config import DATA_DIR
from .ingestion import SMSAdapter, WhatsAppAdapter, persist_report

_SAMPLE_FILE = DATA_DIR / "sample_reports.json"


def seed_sample_reports() -> int:
    with open(_SAMPLE_FILE, "r", encoding="utf-8") as fh:
        samples = json.load(fh)

    wa = WhatsAppAdapter()
    sms = SMSAdapter()
    now = datetime.now(timezone.utc)
    count = 0

    for s in samples:
        created = (now - timedelta(minutes=s.get("minutes_ago", 0))).isoformat()
        if s["channel"] == "whatsapp":
            raw = {
                "From": s.get("reporter_ref"),
                "Latitude": s.get("lat"),
                "Longitude": s.get("lon"),
                "Body": s.get("body", ""),
                "NumMedia": 1 if s.get("media_kind") in {"photo", "voice"} else 0,
                "MediaUrl0": "https://demo.local/media/sample.jpg",
                "MediaContentType0": "image/jpeg"
                if s.get("media_kind") == "photo"
                else "audio/ogg",
            }
            report = wa.normalize(raw)
        else:
            report = sms.normalize({"From": s.get("reporter_ref"), "Body": s.get("body", "")})

        report.created_at = created
        persist_report(report)
        count += 1

    return count
