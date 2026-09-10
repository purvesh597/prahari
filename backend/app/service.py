"""Application service layer: glue between storage, rule engine, and ledger.

Deliberately thin. It loads reports, runs the deterministic rule engine, and
appends verified incidents to the hash-chained ledger. No verdict logic lives
here -- that is the rule engine's job.
"""
from __future__ import annotations

import json

from .db import get_conn
from .ledger import append_entry
from .models import ExtractedFacts, Incident, NormalizedReport
from .rule_engine import evaluate


def load_reports() -> list[NormalizedReport]:
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM reports ORDER BY created_at ASC").fetchall()

    reports: list[NormalizedReport] = []
    for r in rows:
        try:
            facts = ExtractedFacts.model_validate_json(r["extracted"]) if r["extracted"] else ExtractedFacts()
        except Exception:
            facts = ExtractedFacts()
        reports.append(
            NormalizedReport(
                id=r["id"],
                channel=r["channel"],
                reporter_ref=r["reporter_ref"],
                lat=r["lat"],
                lon=r["lon"],
                landmark=r["landmark"],
                media_kind=r["media_kind"] or "none",
                media_uri=r["media_uri"],
                facts=facts,
                created_at=r["created_at"],
            )
        )
    return reports


def report_row(report_id: str) -> dict | None:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM reports WHERE id = ?", (report_id,)).fetchone()
    return dict(row) if row else None


def current_incidents() -> list[Incident]:
    return evaluate(load_reports())


def get_incident(incident_id: str) -> Incident | None:
    for inc in current_incidents():
        if inc.incident_id == incident_id:
            return inc
    return None


def verify_incident(incident_id: str) -> dict | None:
    """Commit an incident's verdict to the tamper-evident ledger."""
    inc = get_incident(incident_id)
    if inc is None:
        return None
    payload = json.loads(inc.model_dump_json())
    entry = append_entry(incident_id, payload)
    return {"incident": payload, "ledger_entry": entry}
