"""Shared data models.

``NormalizedReport`` is the single shape every ingestion adapter must produce.
The WhatsApp adapter and the SMS adapter both emit this exact structure, so the
rule engine and ledger never know or care which channel a report came from.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

from pydantic import BaseModel, Field


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id() -> str:
    return uuid.uuid4().hex


class ExtractedFacts(BaseModel):
    """Structured facts produced by the bounded AI extraction layer.

    This is INPUT to the rule engine. It never contains a verdict or a
    confidence tier -- only observable facts.
    """

    hazard_type: str = "unknown"
    severity_indicators: list[str] = Field(default_factory=list)
    extracted_location_text: Optional[str] = None
    confidence_of_extraction: float = 0.0
    source: str = "mock"  # 'gemini' | 'groq' | 'mock' | 'text'


class NormalizedReport(BaseModel):
    """Channel-agnostic report. Emitted by every ingestion adapter."""

    id: str = Field(default_factory=_new_id)
    channel: str  # 'whatsapp' | 'sms'
    reporter_ref: Optional[str] = None
    lat: Optional[float] = None
    lon: Optional[float] = None
    landmark: Optional[str] = None
    media_kind: str = "none"  # 'photo' | 'voice' | 'text' | 'none'
    media_uri: Optional[str] = None
    facts: ExtractedFacts = Field(default_factory=ExtractedFacts)
    created_at: str = Field(default_factory=_now_iso)


class Incident(BaseModel):
    """A geo/time cluster of reports with a deterministic verdict."""

    incident_id: str
    lat: float
    lon: float
    zone_name: Optional[str] = None
    report_ids: list[str]
    report_count: int
    tier: str
    reasons: list[str]
    ambient_flagged: bool
    ambient_detail: Optional[dict] = None
    first_seen: str
    last_seen: str
