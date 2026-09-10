"""Bounded AI extraction layer.

BOUNDARY (enforced by the brief): AI extracts *facts only*. It returns a
structured ``ExtractedFacts`` object -- hazard type, severity indicators,
readable location text -- and NOTHING resembling a verdict or confidence tier.
The rule engine (app/rule_engine) consumes this output; the AI never decides.

Stack: Gemini 2.5 Flash (primary) -> Groq (fallback) -> deterministic mock.
The mock keeps the whole demo runnable with no API keys.
"""
from __future__ import annotations

import json
import re
from typing import Optional

from ..config import GEMINI_API_KEY, GROQ_API_KEY, GEMINI_MODEL, GROQ_MODEL
from ..models import ExtractedFacts

# The extraction contract. Note: no verdict/tier field exists here by design.
_EXTRACTION_INSTRUCTION = (
    "You are a fact extractor for a flood-reporting system. Look at the media "
    "and return ONLY observable facts as JSON with keys: hazard_type "
    "(string, e.g. 'flood' or 'none'), severity_indicators (list of short "
    "strings, e.g. 'waist-deep water', 'submerged vehicles', 'stranded people'), "
    "extracted_location_text (any readable street sign / landmark text, else null), "
    "confidence_of_extraction (0..1). Do NOT assess urgency, do NOT recommend "
    "action, do NOT rate credibility. Facts only."
)


def extract_from_media(
    media_kind: str, media_uri: Optional[str], hint_text: str = ""
) -> ExtractedFacts:
    """Turn a photo / voice note / text hint into structured facts.

    Falls back gracefully: Gemini -> Groq -> deterministic mock.
    """
    if GEMINI_API_KEY:
        try:
            return _extract_gemini(media_kind, media_uri, hint_text)
        except Exception:
            pass
    if GROQ_API_KEY:
        try:
            return _extract_groq(media_kind, media_uri, hint_text)
        except Exception:
            pass
    return _extract_mock(media_kind, media_uri, hint_text)


# --------------------------------------------------------------------------- #
# Live providers (best-effort; only used when keys are present).
# --------------------------------------------------------------------------- #
def _extract_gemini(media_kind, media_uri, hint_text) -> ExtractedFacts:
    import httpx

    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}"
    )
    prompt = f"{_EXTRACTION_INSTRUCTION}\nMedia kind: {media_kind}. Hint: {hint_text}"
    body = {"contents": [{"parts": [{"text": prompt}]}]}
    resp = httpx.post(url, json=body, timeout=20)
    resp.raise_for_status()
    text = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
    facts = _parse_json_facts(text)
    facts.source = "gemini"
    return facts


def _extract_groq(media_kind, media_uri, hint_text) -> ExtractedFacts:
    import httpx

    url = "https://api.groq.com/openai/v1/chat/completions"
    headers = {"Authorization": f"Bearer {GROQ_API_KEY}"}
    prompt = f"{_EXTRACTION_INSTRUCTION}\nMedia kind: {media_kind}. Hint: {hint_text}"
    body = {
        "model": GROQ_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "response_format": {"type": "json_object"},
    }
    resp = httpx.post(url, headers=headers, json=body, timeout=20)
    resp.raise_for_status()
    text = resp.json()["choices"][0]["message"]["content"]
    facts = _parse_json_facts(text)
    facts.source = "groq"
    return facts


# --------------------------------------------------------------------------- #
# Deterministic mock -- keyword heuristics over the hint text / media kind.
# Produces plausible facts so the pipeline is fully demoable offline.
# --------------------------------------------------------------------------- #
_SEVERITY_PATTERNS = {
    "waist-deep water": r"\bwaist[- ]?deep\b",
    "knee-deep water": r"\bknee[- ]?deep\b",
    "submerged vehicles": r"\b(car|vehicle|bus|auto)s?\b.*\bsubmerg",
    "stranded people": r"\bstranded|trapped|stuck\b",
    "road fully submerged": r"\broad\b.*\b(submerg|underwater|flooded)\b",
    "fast-moving water": r"\b(current|fast[- ]?moving|swept)\b",
}


def _extract_mock(media_kind, media_uri, hint_text) -> ExtractedFacts:
    text = (hint_text or "").lower()

    hazard = "flood" if (media_kind in {"photo", "voice"} or "flood" in text or "water" in text) else "unknown"

    severity: list[str] = []
    for label, pattern in _SEVERITY_PATTERNS.items():
        if re.search(pattern, text):
            severity.append(label)

    # A photo/voice with no explicit words still counts as a visual flood signal.
    if media_kind in {"photo", "voice"} and not severity:
        severity.append("visible flooding")

    location = _extract_location_text(hint_text)

    # Extraction confidence: media-derived facts are more trustworthy than a
    # bare text hint. This is confidence IN THE EXTRACTION, not a verdict.
    if media_kind == "photo":
        conf = 0.85
    elif media_kind == "voice":
        conf = 0.7
    elif media_kind == "text":
        conf = 0.5
    else:
        conf = 0.2

    return ExtractedFacts(
        hazard_type=hazard,
        severity_indicators=severity,
        extracted_location_text=location,
        confidence_of_extraction=conf,
        source="mock",
    )


_LOCATION_HINT = re.compile(
    r"\b(?:near|at|on)\s+([A-Za-z0-9][A-Za-z0-9 .'-]{2,40}?(?:road|rd|marg|station|subway|circle|nagar|chowk|junction|bridge))\b",
    re.IGNORECASE,
)


def _extract_location_text(text: Optional[str]) -> Optional[str]:
    if not text:
        return None
    m = _LOCATION_HINT.search(text)
    if m:
        return m.group(1).strip()
    return None


def _parse_json_facts(text: str) -> ExtractedFacts:
    """Extract the first JSON object from a model response and coerce it."""
    match = re.search(r"\{.*\}", text, re.DOTALL)
    raw = match.group(0) if match else text
    data = json.loads(raw)
    return ExtractedFacts(
        hazard_type=data.get("hazard_type", "unknown"),
        severity_indicators=list(data.get("severity_indicators", []) or []),
        extracted_location_text=data.get("extracted_location_text"),
        confidence_of_extraction=float(data.get("confidence_of_extraction", 0.0) or 0.0),
    )
