"""Prahari FastAPI application.

Endpoints:
  Ingestion (shared pipeline, two adapters):
    POST /webhook/whatsapp   Twilio WhatsApp webhook (form-encoded)
    POST /webhook/sms        Twilio SMS webhook (form-encoded)
    POST /api/report         Generic JSON ingest (demo / testing)

  Officer feed & evidence:
    GET  /api/incidents              Ranked, tiered incident feed
    GET  /api/incidents/{id}         One incident + its member reports
    POST /api/incidents/{id}/verify  Commit verdict to the ledger
    GET  /api/reports                Raw normalized reports
    GET  /api/ambient                Ambient IMD/CWC zone risk
    GET  /api/ledger                 Full hash chain
    GET  /api/ledger/verify          Walk + verify the chain

  Demo helpers:
    POST /api/demo/seed              Load bundled sample reports
    POST /api/demo/tamper            Mutate a ledger row to prove tamper-evidence
"""
from __future__ import annotations

from fastapi import FastAPI, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from .ambient.provider import all_zones
from .config import BASE_DIR
from .db import get_conn, init_db
from .ingestion import SMSAdapter, WhatsAppAdapter, persist_report
from .ledger import get_chain, verify_chain
from .models import NormalizedReport
from .seed import seed_sample_reports
from .service import current_incidents, get_incident, load_reports, report_row, verify_incident

app = FastAPI(title="Prahari", description="Bystander-corroborated disaster verification")

_whatsapp = WhatsAppAdapter()
_sms = SMSAdapter()


@app.on_event("startup")
def _startup() -> None:
    init_db()


# --------------------------------------------------------------------------- #
# Ingestion webhooks -- both feed the SAME pipeline via NormalizedReport.
# --------------------------------------------------------------------------- #
@app.post("/webhook/whatsapp")
async def whatsapp_webhook(request: Request):
    """Twilio WhatsApp webhook. Confirms receipt immediately (builds trust)."""
    form = dict(await request.form())
    report = _whatsapp.normalize(form)
    persist_report(report)
    # Immediate auto-reply (TwiML). Zero further typing required from the sender.
    twiml = (
        "<?xml version='1.0' encoding='UTF-8'?><Response><Message>"
        "\u2705 Prahari received your flood report. Responders are being alerted. "
        "You do not need to do anything else. Stay safe."
        "</Message></Response>"
    )
    return PlainTextResponse(twiml, media_type="application/xml")


@app.post("/webhook/sms")
async def sms_webhook(Body: str = Form(""), From: str = Form("")):
    """Twilio SMS webhook. Format: FLOOD <landmark>."""
    report = _sms.normalize({"Body": Body, "From": From})
    persist_report(report)
    twiml = (
        "<?xml version='1.0' encoding='UTF-8'?><Response><Message>"
        "Prahari received your flood report for "
        f"{report.landmark or 'your area'}. Responders notified."
        "</Message></Response>"
    )
    return PlainTextResponse(twiml, media_type="application/xml")


@app.post("/api/report")
def api_report(raw: dict):
    """Generic ingest. `channel` selects the adapter; rest is adapter-specific."""
    channel = (raw.get("channel") or "whatsapp").lower()
    adapter = _sms if channel == "sms" else _whatsapp
    report = adapter.normalize(raw)
    persist_report(report)
    return report.model_dump()


# --------------------------------------------------------------------------- #
# Officer feed & evidence
# --------------------------------------------------------------------------- #
@app.get("/api/incidents")
def api_incidents():
    return [i.model_dump() for i in current_incidents()]


@app.get("/api/incidents/{incident_id}")
def api_incident(incident_id: str):
    inc = get_incident(incident_id)
    if inc is None:
        raise HTTPException(404, "incident not found")
    reports = [report_row(rid) for rid in inc.report_ids]
    return {"incident": inc.model_dump(), "reports": reports}


@app.post("/api/incidents/{incident_id}/verify")
def api_verify(incident_id: str):
    result = verify_incident(incident_id)
    if result is None:
        raise HTTPException(404, "incident not found")
    return result


@app.get("/api/reports")
def api_reports():
    return [r.model_dump() for r in load_reports()]


@app.get("/api/ambient")
def api_ambient():
    return {"zones": all_zones()}


@app.get("/api/ledger")
def api_ledger():
    return {"chain": get_chain()}


@app.get("/api/ledger/verify")
def api_ledger_verify():
    return verify_chain()


# --------------------------------------------------------------------------- #
# Demo helpers
# --------------------------------------------------------------------------- #
@app.post("/api/demo/seed")
def api_seed():
    n = seed_sample_reports()
    return {"seeded": n}


@app.post("/api/demo/tamper")
def api_tamper(seq: int | None = None):
    """Deliberately alter a ledger row's payload WITHOUT recomputing hashes.

    Demonstrates that /api/ledger/verify then detects the break. Demo-only.
    """
    with get_conn() as conn:
        if seq is None:
            row = conn.execute("SELECT seq FROM ledger ORDER BY seq ASC LIMIT 1").fetchone()
            if row is None:
                raise HTTPException(400, "ledger is empty; verify an incident first")
            seq = row["seq"]
        cur = conn.execute(
            "UPDATE ledger SET payload = json_set(payload, '$.tier', 'TAMPERED') WHERE seq = ?",
            (seq,),
        )
        if cur.rowcount == 0:
            raise HTTPException(404, f"no ledger entry with seq={seq}")
    return {"tampered_seq": seq, "hint": "now call GET /api/ledger/verify"}


# --------------------------------------------------------------------------- #
# Static officer dashboard
# --------------------------------------------------------------------------- #
_FRONTEND_DIR = BASE_DIR.parent / "frontend"
if _FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(_FRONTEND_DIR), html=True), name="frontend")
