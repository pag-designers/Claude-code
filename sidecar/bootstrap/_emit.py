"""JSON-lines protocol shared by the bootstrap scripts (read by SidecarManager).

Every line on stdout is one JSON object:
  {"type":"progress","phase":"downloading-model","progress":0.42,"message":"..."}
  {"type":"log","message":"..."}
  {"type":"result","ok":true,...}
  {"type":"error","message":"..."}
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from typing import Any

# Make `clipfern_sidecar` importable when a script is run as `python bootstrap/<script>.py`.
_SIDECAR_ROOT = str(Path(__file__).resolve().parent.parent)
if _SIDECAR_ROOT not in sys.path:
    sys.path.insert(0, _SIDECAR_ROOT)


def emit(kind: str, **fields: Any) -> None:
    sys.stdout.write(json.dumps({"type": kind, **fields}, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def progress(phase: str, fraction: float | None, message: str) -> None:
    value = None if fraction is None else round(max(0.0, min(1.0, fraction)), 4)
    emit("progress", phase=phase, progress=value, message=message)


class Throttle:
    """Lets a progress line through at most every `interval` seconds (final value always passes)."""

    def __init__(self, interval: float = 0.25) -> None:
        self.interval = interval
        self._last = 0.0

    def ready(self, force: bool = False) -> bool:
        now = time.monotonic()
        if force or now - self._last >= self.interval:
            self._last = now
            return True
        return False


def fmt_bytes(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} GB"
