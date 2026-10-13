#!/usr/bin/env python
"""Download the MediaPipe BlazeFace short-range detector (.tflite, ~230 KB) with progress.

    python download_face_model.py --models-dir <dir>
"""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
import traceback
import ssl
import urllib.request

from _emit import Throttle, emit, fmt_bytes, progress

PHASE = "downloading-model"
SHA256 = "b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f"


def _ssl_context() -> ssl.SSLContext:
    """Trust the OS certificate store (corporate proxies); fall back to certifi's bundle."""
    try:
        import truststore

        return truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    except Exception:  # noqa: BLE001
        import certifi

        return ssl.create_default_context(cafile=certifi.where())


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--models-dir", required=True)
    args = parser.parse_args()
    os.environ["CLIPFERN_MODELS_DIR"] = args.models_dir

    from clipfern_sidecar import paths

    dest = paths.face_model_path()
    marker = dest.parent / (paths.FACE_MODEL_FILENAME + paths.COMPLETE_MARKER)
    if paths.face_model_ready():
        progress(PHASE, 1.0, "Face detector model is already downloaded")
        emit("result", ok=True, path=str(dest), cached=True)
        return 0

    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".tflite.part")
    digest = hashlib.sha256()
    throttle = Throttle()
    progress(PHASE, 0.0, "Downloading face detector model")
    request = urllib.request.Request(paths.FACE_MODEL_URL, headers={"User-Agent": "clipfern-sidecar"})
    with (
        urllib.request.urlopen(request, timeout=60, context=_ssl_context()) as resp,  # noqa: S310
        open(tmp, "wb") as out,
    ):
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        while chunk := resp.read(64 * 1024):
            out.write(chunk)
            digest.update(chunk)
            done += len(chunk)
            if throttle.ready():
                progress(
                    PHASE,
                    (done / total) if total else None,
                    f"Downloading face detector: {fmt_bytes(done)}"
                    + (f" / {fmt_bytes(total)}" if total else ""),
                )
    if digest.hexdigest() != SHA256:
        tmp.unlink(missing_ok=True)
        emit("error", message="Face detector model checksum mismatch")
        return 3
    os.replace(tmp, dest)
    marker.write_text(SHA256, encoding="utf-8")
    progress(PHASE, 1.0, f"Downloaded face detector ({fmt_bytes(done)})")
    emit("result", ok=True, path=str(dest), cached=False, bytes=done)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except BaseException as exc:  # noqa: BLE001
        emit("error", message=f"{type(exc).__name__}: {exc}", trace=traceback.format_exc()[-1500:])
        sys.exit(1)
