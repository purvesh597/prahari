"""Central configuration for Prahari.

All tunables live here so the rule engine, ledger, and ingestion layers stay
inspectable. Nothing here is derived from an LLM.
"""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = os.environ.get("PRAHARI_DB", str(BASE_DIR / "prahari.db"))

# --- Demo hazard scope: urban flooding only (Maharashtra monsoon context) ---
HAZARD_SCOPE = "flood"

# --- Rule-engine tunables (deterministic, inspectable) ---
# Reports within this radius (km) and time window (minutes) are treated as the
# same incident cluster.
CLUSTER_RADIUS_KM = 0.75
CLUSTER_WINDOW_MINUTES = 60

# Confidence tiers emitted by the rule engine.
TIER_UNVERIFIED = "Unverified"
TIER_CORROBORATED = "Corroborated"
TIER_HIGH_CONFIDENCE = "High-Confidence"

# --- AI extraction ---
# Keys are optional. When absent, the extraction layer falls back to a
# deterministic mock so the demo runs fully offline.
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
GEMINI_MODEL = "gemini-2.5-flash"
GROQ_MODEL = "llama-3.3-70b-versatile"

# --- Ambient data layer ---
# When true, use the bundled mock IMD/CWC feed. Swap for a live client later.
AMBIENT_USE_MOCK = os.environ.get("PRAHARI_AMBIENT_MOCK", "1") == "1"
AMBIENT_MOCK_FILE = DATA_DIR / "ambient_mock.json"
