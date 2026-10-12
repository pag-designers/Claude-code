"""Paths and settings. Everything configurable lives in .env (see .env.example)."""
import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")

DATA = ROOT / "data"
OUTPUT = ROOT / "output"
PROMPTS = ROOT / "prompts"
FONTS = ROOT / "assets" / "fonts"
MODELS = DATA / "models"
CAMPAIGNS = DATA / "campaigns"
for d in (DATA, OUTPUT, MODELS, CAMPAIGNS):
    d.mkdir(parents=True, exist_ok=True)

CLAUDE_MODEL = os.getenv("CLIPPER_MODEL", "claude-opus-5-5")
CLAUDE_EFFORT = os.getenv("CLIPPER_EFFORT", "medium")
WHISPER_MODEL = os.getenv("CLIPPER_WHISPER_MODEL", "small")  # tiny | base | small | medium | large-v3
WHISPER_THREADS = int(os.getenv("CLIPPER_WHISPER_THREADS", str(os.cpu_count() or 4)))

# $ per million tokens, used only for the cost log (see data/usage.jsonl).
PRICES = {
    "claude-opus-5-5": (4.00, 20.00),
    "claude-sonnet-5-5": (2.00, 10.00),
    "claude-haiku-5-5": (0.10, 0.50),
}


def video_dir(video_id: str) -> Path:
    d = DATA / video_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def has_api_key() -> bool:
    return bool(os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_AUTH_TOKEN"))
