"""Tiny JSON-file storage helpers: every artifact lives in data/<video_id>/<name>.json."""
import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any

from .config import DATA, video_dir


def read_json(path: Path, default: Any = None) -> Any:
    for i in range(40):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except PermissionError:  # Windows: file is being replaced right now; wait, don't pretend it's empty
            if i == 39:
                raise
            time.sleep(0.05)
        except (OSError, json.JSONDecodeError):
            return default


def write_json(path: Path, data: Any) -> None:
    # Write to a temp file then rename, so a crash never leaves half-written JSON.
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    replace_retry(tmp, path)


def replace_retry(src, dst, tries: int = 40) -> None:
    """os.replace, retried: on Windows it fails while another thread/antivirus/OneDrive has the file open."""
    for i in range(tries):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if i == tries - 1:
                raise
            time.sleep(0.05)


def load(video_id: str, name: str, default: Any = None) -> Any:
    return read_json(DATA / video_id / f"{name}.json", default)


def save(video_id: str, name: str, data: Any) -> None:
    write_json(video_dir(video_id) / f"{name}.json", data)


def list_videos() -> list[dict]:
    out = []
    for d in sorted((p for p in DATA.iterdir() if p.is_dir()), key=lambda p: p.stat().st_mtime, reverse=True):
        meta = read_json(d / "meta.json")
        if meta:
            meta["status"] = read_json(d / "status.json", {})
            out.append(meta)
    return out


def set_status(video_id: str, stage: str, progress: float = 0.0, message: str = "", error: str | None = None) -> None:
    status = load(video_id, "status", {})
    status.update(stage=stage, progress=round(progress, 3), message=message, error=error)
    try:
        save(video_id, "status", status)
    except OSError:  # progress display only: never let it kill a download or transcription
        pass
