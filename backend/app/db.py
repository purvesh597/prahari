"""SQLite persistence layer.

Two tables:
  * reports  - every normalized bystander report from any channel
  * ledger   - append-only, hash-chained record of verified incidents

The hash-chain logic lives in the application layer (app/ledger), NOT in the
database. The database only stores the ``previous_hash`` / ``entry_hash``
columns so the chain can be walked and re-verified.
"""
import sqlite3
from contextlib import contextmanager

from .config import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS reports (
    id             TEXT PRIMARY KEY,
    channel        TEXT NOT NULL,          -- 'whatsapp' | 'sms'
    reporter_ref   TEXT,                   -- opaque sender id (never PII in demo)
    lat            REAL,
    lon            REAL,
    landmark       TEXT,                   -- free-text landmark (SMS) or extracted
    media_kind     TEXT,                   -- 'photo' | 'voice' | 'text' | 'none'
    media_uri      TEXT,
    hazard_type    TEXT,
    severity       TEXT,                   -- extracted severity indicator
    extracted      TEXT,                   -- raw extraction JSON
    created_at     TEXT NOT NULL           -- ISO8601 UTC
);

CREATE TABLE IF NOT EXISTS ledger (
    seq            INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id    TEXT NOT NULL,
    payload        TEXT NOT NULL,          -- canonical JSON of the verified incident
    previous_hash  TEXT NOT NULL,
    entry_hash     TEXT NOT NULL,
    created_at     TEXT NOT NULL
);
"""


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=5.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA busy_timeout=5000;")
    return conn


def init_db() -> None:
    with _connect() as conn:
        conn.executescript(SCHEMA)


@contextmanager
def get_conn():
    conn = _connect()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()
