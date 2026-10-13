"""Entry point: `python -m clipfern_sidecar --port 51234` with SIDECAR_TOKEN in the environment."""

from __future__ import annotations

import argparse
import os
import sys
import threading


def _exit_when_stdin_closes() -> None:
    """The Electron main process keeps our stdin pipe open; if it dies the pipe closes and
    we exit, so a crashed app never leaves an orphaned sidecar holding GPU memory."""

    def watch() -> None:
        try:
            while sys.stdin.buffer.read(1024):
                pass
        except Exception:  # noqa: BLE001
            pass
        os._exit(0)

    threading.Thread(target=watch, name="stdin-watchdog", daemon=True).start()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="clipfern_sidecar")
    parser.add_argument("--port", type=int, required=True, help="TCP port on 127.0.0.1")
    parser.add_argument(
        "--exit-on-stdin-eof",
        action="store_true",
        help="exit when stdin is closed (set by the Electron parent)",
    )
    args = parser.parse_args(argv)

    token = os.environ.get("SIDECAR_TOKEN", "")
    if len(token) < 16:
        print("SIDECAR_TOKEN must be set to a random string of at least 16 characters", file=sys.stderr)
        return 2

    if args.exit_on_stdin_eof:
        _exit_when_stdin_closes()

    # Keep MediaPipe/LiteRT/absl native logging down to warnings so the log view stays readable.
    os.environ.setdefault("GLOG_minloglevel", "2")
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")

    import uvicorn

    from .app import create_app

    uvicorn.run(
        create_app(token),
        host="127.0.0.1",  # loopback only, by design
        port=args.port,
        log_level="warning",
        access_log=False,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
