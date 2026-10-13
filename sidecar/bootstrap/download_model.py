#!/usr/bin/env python
"""Download a faster-whisper (CTranslate2) model with byte-level progress.

    python download_model.py <model> --models-dir <dir>

Idempotent and resumable: a finished download leaves `.clipfern-complete` and is skipped;
an interrupted one continues from the partial files kept by huggingface_hub.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import sys
import threading
import traceback

from _emit import Throttle, emit, fmt_bytes, progress

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
PHASE = "downloading-model"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("model")
    parser.add_argument("--models-dir", required=True)
    args = parser.parse_args()
    os.environ["CLIPFERN_MODELS_DIR"] = args.models_dir

    from clipfern_sidecar import paths

    try:
        repo = paths.whisper_repo(args.model)
    except ValueError as exc:
        emit("error", message=str(exc))
        return 2

    target = paths.whisper_model_dir(args.model)
    if paths.whisper_model_ready(args.model):
        progress(PHASE, 1.0, f"Model '{args.model}' is already downloaded")
        emit("result", ok=True, model=args.model, path=str(target), cached=True)
        return 0

    from huggingface_hub import HfApi, snapshot_download
    from tqdm.auto import tqdm

    progress(PHASE, 0.0, f"Looking up '{args.model}' ({repo})")
    info = HfApi().model_info(repo, files_metadata=True)
    wanted = [
        s
        for s in (info.siblings or [])
        if any(fnmatch.fnmatch(s.rfilename, pat) for pat in paths.WHISPER_ALLOW_PATTERNS)
    ]
    total = sum(int(s.size or 0) for s in wanted)
    if total <= 0:
        emit("error", message=f"No downloadable model files found in {repo}")
        return 3

    state = {"done": 0}
    lock = threading.Lock()
    throttle = Throttle()

    def report(force: bool = False) -> None:
        if throttle.ready(force):
            done = min(state["done"], total)
            progress(
                PHASE,
                done / total,
                f"Downloading {args.model}: {fmt_bytes(done)} / {fmt_bytes(total)}",
            )

    class ByteProgress(tqdm):  # type: ignore[misc]
        """huggingface_hub drives one of these per file (unit='B') plus one 'files' bar."""

        def __init__(self, *a, **kw):  # noqa: ANN002, ANN003
            kw["disable"] = False
            kw.setdefault("file", open(os.devnull, "w"))  # noqa: SIM115 - keep tqdm silent
            super().__init__(*a, **kw)
            self._is_bytes = kw.get("unit") == "B"
            if self._is_bytes and self.n:
                with lock:
                    state["done"] += int(self.n)  # resumed bytes already on disk

        def update(self, n=1):  # noqa: ANN001, ANN201
            if self._is_bytes and n:
                with lock:
                    state["done"] += int(n)
                report()
            return super().update(n)

    snapshot_download(
        repo,
        local_dir=str(target),
        allow_patterns=paths.WHISPER_ALLOW_PATTERNS,
        tqdm_class=ByteProgress,
    )
    missing = [p for p in ("model.bin", "config.json") if not (target / p).is_file()]
    if missing:
        emit("error", message=f"Download finished but files are missing: {', '.join(missing)}")
        return 4
    (target / paths.COMPLETE_MARKER).write_text(
        json.dumps({"model": args.model, "repo": repo, "bytes": total}), encoding="utf-8"
    )
    progress(PHASE, 1.0, f"Downloaded {args.model} ({fmt_bytes(total)})")
    emit("result", ok=True, model=args.model, path=str(target), cached=False, bytes=total)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except BaseException as exc:  # noqa: BLE001
        emit("error", message=f"{type(exc).__name__}: {exc}", trace=traceback.format_exc()[-1500:])
        sys.exit(1)
