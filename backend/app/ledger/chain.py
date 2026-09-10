"""Tamper-evident evidence ledger.

Every verified incident is appended to an append-only log. Each entry stores:

    entry_hash = SHA256( canonical(payload) + previous_hash )

Because each hash folds in the previous hash, altering any past entry's payload
changes its ``entry_hash``, which no longer matches the ``previous_hash`` stored
in the following entry -- so ``verify_chain`` detects the break and names the
first bad entry. This is demoable live: edit a row, re-verify, watch it fail.

The hash-chain logic lives here in the application layer, not in the database.
The DB only stores the columns.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone

from ..db import get_conn

# Anchor for the very first entry (no predecessor).
GENESIS_HASH = "0" * 64


def _canonical(payload: dict) -> str:
    """Deterministic serialization so hashing is stable across runs."""
    return json.dumps(payload, sort_keys=True, separators=(",", ":"))


def compute_entry_hash(payload: dict, previous_hash: str) -> str:
    material = (_canonical(payload) + previous_hash).encode("utf-8")
    return hashlib.sha256(material).hexdigest()


def _latest_hash(conn) -> str:
    row = conn.execute(
        "SELECT entry_hash FROM ledger ORDER BY seq DESC LIMIT 1"
    ).fetchone()
    return row["entry_hash"] if row else GENESIS_HASH


def append_entry(incident_id: str, payload: dict) -> dict:
    """Append a verified incident to the ledger and return the new entry."""
    created_at = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        prev = _latest_hash(conn)
        entry_hash = compute_entry_hash(payload, prev)
        cur = conn.execute(
            """
            INSERT INTO ledger (incident_id, payload, previous_hash, entry_hash, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (incident_id, _canonical(payload), prev, entry_hash, created_at),
        )
        seq = cur.lastrowid
    return {
        "seq": seq,
        "incident_id": incident_id,
        "previous_hash": prev,
        "entry_hash": entry_hash,
        "created_at": created_at,
    }


def get_chain() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM ledger ORDER BY seq ASC").fetchall()
    return [dict(r) for r in rows]


def verify_chain() -> dict:
    """Walk the chain and confirm no entry has been altered.

    Returns a report: {valid, length, broken_at, detail}. ``broken_at`` is the
    seq of the first entry whose stored/recomputed hashes or link diverge.
    """
    prev = GENESIS_HASH
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM ledger ORDER BY seq ASC").fetchall()

    for row in rows:
        payload = json.loads(row["payload"])

        if row["previous_hash"] != prev:
            return {
                "valid": False,
                "length": len(rows),
                "broken_at": row["seq"],
                "detail": "previous_hash does not match prior entry's hash "
                "(a preceding entry was altered or removed).",
            }

        recomputed = compute_entry_hash(payload, row["previous_hash"])
        if recomputed != row["entry_hash"]:
            return {
                "valid": False,
                "length": len(rows),
                "broken_at": row["seq"],
                "detail": "entry payload was modified after it was written "
                "(recomputed hash != stored hash).",
            }

        prev = row["entry_hash"]

    return {"valid": True, "length": len(rows), "broken_at": None, "detail": "chain intact"}
