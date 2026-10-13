#!/usr/bin/env python
"""Import every sidecar dependency and report versions as JSON lines.

    python selfcheck.py

Exit code 0 = healthy. On failure prints {"type":"error", ...} and exits 1.
"""

from __future__ import annotations

import importlib
import platform
import sys
import traceback
from importlib import metadata

from _emit import emit, progress

PHASE = "installing-packages"

# (import name, distribution name)
CHECKS = [
    ("numpy", "numpy"),
    ("cv2", "opencv-python"),
    ("fastapi", "fastapi"),
    ("uvicorn", "uvicorn"),
    ("huggingface_hub", "huggingface-hub"),
    ("ctranslate2", "ctranslate2"),
    ("faster_whisper", "faster-whisper"),
    ("scenedetect", "scenedetect"),
    ("mediapipe", "mediapipe"),
]


def main() -> int:
    versions: dict[str, str | None] = {}
    for i, (module, dist) in enumerate(CHECKS):
        progress(PHASE, i / len(CHECKS), f"Checking {dist}")
        try:
            importlib.import_module(module)
        except Exception as exc:  # noqa: BLE001
            emit("error", message=f"Cannot import {module}: {type(exc).__name__}: {exc}", module=module)
            return 1
        try:
            versions[dist] = metadata.version(dist)
        except metadata.PackageNotFoundError:
            versions[dist] = None

    # mediapipe's native library (needs libEGL/libGLES on Linux) is only loaded lazily.
    try:
        from mediapipe.tasks.python.core import mediapipe_c_bindings

        mediapipe_c_bindings.load_raw_library()
    except Exception as exc:  # noqa: BLE001
        hint = ""
        if sys.platform.startswith("linux"):
            hint = " (on Linux install the system packages libegl1 and libgles2)"
        emit("error", message=f"MediaPipe native library failed to load: {exc}{hint}", module="mediapipe")
        return 1

    from clipfern_sidecar.device import detect

    device = detect()
    progress(PHASE, 1.0, "All sidecar packages import correctly")
    emit(
        "result",
        ok=True,
        python=platform.python_version(),
        platform=f"{sys.platform}-{platform.machine()}",
        versions=versions,
        device=device.device,
        whisper_device=device.whisper_device,
        compute_type=device.compute_type,
        cuda_devices=device.cuda_devices,
        note=device.note,
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except BaseException as exc:  # noqa: BLE001
        emit("error", message=f"{type(exc).__name__}: {exc}", trace=traceback.format_exc()[-1500:])
        sys.exit(1)
