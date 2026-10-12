"""Tiny JSON-file storage helpers: every artifact lives in data/<video_id>/<name>.json."""
import json
import os
import tempfile
from pathlib import Path
from typing import Any

from .config import DATA, video_dir


def read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(path: Path, data: Any) -> None:
    # Write to a temp file then rename, so a crash never leaves half-written JSON.
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def load(video_id: str, name: str, default: Any = None) -> Any:
    return read_json(video_dir(video_id) / f"{name}.json", default)


def save(video_id: str, name: str, data: Any) -> None:
    write_json(video_dir(video_id) / f"{name}.json", data)


def list_videos() -> list[dict]:
    out = []
    for d in sorted(DATA.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        meta = read_json(d / "meta.json")
        if meta:
            meta["status"] = read_json(d / "status.json", {})
            out.append(meta)
    return out


def set_status(video_id: str, stage: str, progress: float = 0.0, message: str = "", error: str | None = None) -> None:
    status = load(video_id, "status", {})
    status.update(stage=stage, progress=round(progress, 3), message=message, error=error)
    save(video_id, "status", status)
