"""Paths and settings. Everything configurable lives in .env (see .env.example) and can be changed from the app's
Settings panel, which rewrites .env and reloads it."""
import os
import re
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = ROOT / ".env"
load_dotenv(ENV_FILE)

DATA = ROOT / "data"
OUTPUT = ROOT / "output"
PROMPTS = ROOT / "prompts"
FONTS = ROOT / "assets" / "fonts"
MODELS = DATA / "models"
CAMPAIGNS = DATA / "campaigns"
for d in (DATA, OUTPUT, MODELS, CAMPAIGNS):
    d.mkdir(parents=True, exist_ok=True)

# Cheapest first. (input $/M tokens, output $/M tokens) — used only for the cost log.
MODEL_CHOICES = {
    "claude-haiku-5-5": {"label": "Haiku 5.5 — cheapest (~$0.05 per hour of video)", "prices": (0.10, 0.50)},
    "claude-sonnet-5-5": {"label": "Sonnet 5.5 — balanced (~$0.85 per hour of video)", "prices": (2.00, 10.00)},
    "claude-opus-5-5": {"label": "Opus 5.5 — best quality (~$1.70 per hour of video)", "prices": (4.00, 20.00)},
}
PRICES = {k: v["prices"] for k, v in MODEL_CHOICES.items()}
EFFORTS = ["low", "medium", "high"]
DEFAULT_MODEL = "claude-haiku-5-5"

WHISPER_MODEL = os.getenv("CLIPPER_WHISPER_MODEL", "small")  # tiny | base | small | medium | large-v3
WHISPER_THREADS = int(os.getenv("CLIPPER_WHISPER_THREADS", str(os.cpu_count() or 4)))


def claude_model() -> str:
    m = os.getenv("CLIPPER_MODEL", DEFAULT_MODEL)
    return m if m in MODEL_CHOICES else DEFAULT_MODEL


def claude_effort() -> str:
    e = os.getenv("CLIPPER_EFFORT", "medium")
    return e if e in EFFORTS else "medium"


def video_dir(video_id: str) -> Path:
    d = DATA / video_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def api_key() -> str:
    key = os.getenv("ANTHROPIC_API_KEY", "") or os.getenv("ANTHROPIC_AUTH_TOKEN", "")
    return "" if "your-key" in key else key


def has_api_key() -> bool:
    return bool(api_key())


def save_settings(**values: str | None) -> None:
    """Write ANTHROPIC_API_KEY / CLIPPER_MODEL / CLIPPER_EFFORT into .env (creating it) and apply them now."""
    allowed = {"ANTHROPIC_API_KEY", "CLIPPER_MODEL", "CLIPPER_EFFORT"}
    text = ENV_FILE.read_text(encoding="utf-8") if ENV_FILE.exists() else ""
    for k, v in values.items():
        if k not in allowed or v is None:
            continue
        v = v.strip()
        line = f"{k}={v}"
        if re.search(rf"^\s*#?\s*{k}=.*$", text, re.M):
            text = re.sub(rf"^\s*#?\s*{k}=.*$", line, text, count=1, flags=re.M)
        else:
            text = text.rstrip("\n") + ("\n" if text else "") + line + "\n"
        os.environ[k] = v
    ENV_FILE.write_text(text, encoding="utf-8")
