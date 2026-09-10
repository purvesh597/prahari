"""Tests for the tamper-evident hash-chained ledger.

Uses an isolated temp DB so tests never touch the demo database.
"""
import importlib
import json

import pytest


@pytest.fixture()
def ledger(tmp_path, monkeypatch):
    db_file = tmp_path / "test.db"
    monkeypatch.setenv("PRAHARI_DB", str(db_file))

    # Reimport modules so they pick up the patched DB path.
    from app import config
    importlib.reload(config)
    from app import db
    importlib.reload(db)
    from app.ledger import chain
    importlib.reload(chain)

    db.init_db()
    return chain, db


def test_append_links_to_genesis(ledger):
    chain, _ = ledger
    entry = chain.append_entry("inc1", {"tier": "High-Confidence"})
    assert entry["previous_hash"] == chain.GENESIS_HASH
    assert len(entry["entry_hash"]) == 64


def test_each_entry_links_to_previous(ledger):
    chain, _ = ledger
    e1 = chain.append_entry("inc1", {"tier": "Corroborated"})
    e2 = chain.append_entry("inc2", {"tier": "High-Confidence"})
    assert e2["previous_hash"] == e1["entry_hash"]


def test_verify_intact_chain(ledger):
    chain, _ = ledger
    chain.append_entry("inc1", {"tier": "Corroborated"})
    chain.append_entry("inc2", {"tier": "High-Confidence"})
    report = chain.verify_chain()
    assert report["valid"] is True
    assert report["length"] == 2
    assert report["broken_at"] is None


def test_tampering_payload_breaks_chain(ledger):
    chain, db = ledger
    chain.append_entry("inc1", {"tier": "Corroborated"})
    chain.append_entry("inc2", {"tier": "High-Confidence"})

    # Alter a stored payload WITHOUT recomputing hashes -> must be detected.
    with db.get_conn() as conn:
        conn.execute(
            "UPDATE ledger SET payload = ? WHERE seq = 1",
            (json.dumps({"tier": "TAMPERED"}),),
        )

    report = chain.verify_chain()
    assert report["valid"] is False
    assert report["broken_at"] == 1


def test_deterministic_hash(ledger):
    chain, _ = ledger
    h1 = chain.compute_entry_hash({"a": 1, "b": 2}, chain.GENESIS_HASH)
    h2 = chain.compute_entry_hash({"b": 2, "a": 1}, chain.GENESIS_HASH)
    assert h1 == h2  # key order must not change the hash
