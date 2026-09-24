"""API-level tests for the demo helpers the officer console relies on.

Uses an isolated temp DB so tests never touch the demo database.
"""
import importlib

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PRAHARI_DB", str(tmp_path / "test.db"))

    from app import config
    importlib.reload(config)
    from app import db
    importlib.reload(db)
    from app.ledger import chain
    importlib.reload(chain)
    from app import ledger, service, seed, main
    importlib.reload(ledger)
    importlib.reload(service)
    importlib.reload(seed)
    importlib.reload(main)

    with TestClient(main.app) as c:
        yield c


def test_reset_clears_reports_and_restarts_ledger(client):
    client.post("/api/demo/seed")
    incidents = client.get("/api/incidents").json()
    assert incidents
    client.post(f"/api/incidents/{incidents[0]['incident_id']}/verify")
    assert client.get("/api/ledger").json()["chain"]

    assert client.post("/api/demo/reset").json() == {"reset": True}
    assert client.get("/api/incidents").json() == []
    assert client.get("/api/ledger").json()["chain"] == []

    # Ledger sequence restarts, so a replayed demo reads #1, #2, ...
    client.post("/api/demo/seed")
    first = client.get("/api/incidents").json()[0]
    entry = client.post(f"/api/incidents/{first['incident_id']}/verify").json()["ledger_entry"]
    assert entry["seq"] == 1
    assert client.get("/api/ledger/verify").json()["valid"] is True


def test_sms_report_ingest_resolves_landmark(client):
    r = client.post("/api/report", json={"channel": "sms", "From": "sms:+91000", "Body": "FLOOD Hindmata"})
    assert r.status_code == 200
    body = r.json()
    assert body["channel"] == "sms"
    assert body["lat"] is not None and body["lon"] is not None
