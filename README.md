# Prahari (प्रहरी — "sentinel")

**Bystander-corroborated disaster verification.** Prahari gives responders a
trustworthy, tamper-evident flood triage feed — without depending on panicked
victims to self-report, and without any physical hardware.

> Demo scope: urban flooding, Mumbai / Maharashtra monsoon context.

## Why it's different

- **Bystanders, not victims.** Reports are filed by nearby, safe people — one
  tap, a photo, or a voice note. Zero typing required.
- **Deterministic verdict, bounded AI.** An inspectable rule engine — *not* an
  LLM — decides the confidence tier. AI is used **only** to extract structured
  facts (hazard, severity, location text) from media. AI never issues the verdict.
- **Tamper-evident by design.** Every verified incident is appended to a
  SHA-256 hash-chained ledger. Editing any past entry breaks the chain, and the
  verifier proves it live.
- **Corroboration before detection.** A mocked IMD/CWC ambient layer flags
  high-risk zones *before* any citizen report arrives, so reports corroborate
  rather than solely trigger.
- **Software-only, graceful degradation.** WhatsApp is the primary channel; an
  SMS fallback (`FLOOD <landmark>`) feeds the same pipeline for data-only outages.

## Architecture

```
Ingestion (shared pipeline, 2 adapters)      →  WhatsApp + SMS  →  NormalizedReport
AI extraction (facts only, Gemini→Groq→mock) →  structured JSON facts
Rule engine (deterministic)                  →  geo/time clustering + confidence tiers
Ambient layer (mocked IMD/CWC)               →  zone-risk corroboration
Evidence ledger (SHA-256 hash chain)         →  append + tamper-evident verify
Officer dashboard (FastAPI + Leaflet)        →  map, list, evidence drill-down
```

Confidence tiers: **Unverified · Corroborated · High-Confidence**, each with an
explicit, human-readable reason — never a black-box score.

## Run

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --port 8799
```

Open **http://localhost:8799**, then:

1. **Seed demo reports** → three tiered incidents appear.
2. Click an incident → inspect reports, extracted facts, ambient corroboration.
3. **Commit to evidence ledger** → appends a hash-chained entry.
4. **Simulate tamper** → **Verify chain** flags the break.

Tests: `cd backend && pytest` (rule engine + ledger).

## Out of scope (by design)

No hardware/IoT, no live satellite verification, no multi-hazard support, no
auto-dispatch, and no claim to solve total infrastructure collapse (dead towers /
power) — that remains the domain of radio / satellite-phone infrastructure.
