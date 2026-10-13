"""Where model files live and which Hugging Face repo each Whisper model name maps to.

Kept free of heavy imports so the bootstrap scripts and the server share one definition.
"""

from __future__ import annotations

import os
from pathlib import Path

COMPLETE_MARKER = ".clipfern-complete"

# Whisper model names accepted by Clipfern settings -> CTranslate2 conversions on the HF hub.
WHISPER_REPOS: dict[str, str] = {
    "tiny": "Systran/faster-whisper-tiny",
    "base": "Systran/faster-whisper-base",
    "small": "Systran/faster-whisper-small",
    "medium": "Systran/faster-whisper-medium",
    "large-v3": "Systran/faster-whisper-large-v3",
    "large-v3-turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
    "turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
}

# Files faster-whisper needs; skips README, .gitattributes, etc.
WHISPER_ALLOW_PATTERNS = [
    "config.json",
    "preprocessor_config.json",
    "model.bin",
    "tokenizer.json",
    "vocabulary.*",
]

FACE_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_detector/"
    "blaze_face_short_range/float16/1/blaze_face_short_range.tflite"
)
FACE_MODEL_FILENAME = "blaze_face_short_range.tflite"


def models_dir() -> Path:
    env = os.environ.get("CLIPFERN_MODELS_DIR")
    if env:
        return Path(env)
    return Path.home() / ".cache" / "clipfern" / "models"


def whisper_repo(name: str) -> str:
    """Map a model name to a HF repo id. `org/repo` ids pass through unchanged."""
    if "/" in name:
        return name
    repo = WHISPER_REPOS.get(name)
    if repo is None:
        raise ValueError(f"Unknown Whisper model '{name}'. Expected one of: {', '.join(WHISPER_REPOS)}")
    return repo


def whisper_model_dir(name: str) -> Path:
    return models_dir() / "whisper" / name.replace("/", "__")


def whisper_model_ready(name: str) -> bool:
    d = whisper_model_dir(name)
    return (d / COMPLETE_MARKER).is_file() and (d / "model.bin").is_file()


def face_model_path() -> Path:
    return models_dir() / "mediapipe" / FACE_MODEL_FILENAME


def face_model_ready() -> bool:
    p = face_model_path()
    return (p.parent / (FACE_MODEL_FILENAME + COMPLETE_MARKER)).is_file() and p.is_file()
