"""Check that every tool the clipper needs is installed. Run: python scripts/doctor.py"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HINTS = {
    "node": "mac: brew install node | win: winget install OpenJS.NodeJS.LTS | ubuntu: sudo apt install nodejs",
    "ffmpeg": "mac: brew install ffmpeg | win: winget install Gyan.FFmpeg | ubuntu: sudo apt install ffmpeg",
    "ffprobe": "comes with ffmpeg (see above)",
    "yt-dlp": "python -m pip install -r requirements.txt  (or just start run.bat / run.sh)",
}


def version_of(cmd: str, flag: str = "--version") -> str | None:
    # Prefer the copy inside .venv so we test what the app will actually use.
    venv_bin = ROOT / ".venv" / ("Scripts" if os.name == "nt" else "bin") / cmd
    path = str(venv_bin) if venv_bin.exists() or venv_bin.with_suffix(".exe").exists() else shutil.which(cmd)
    if not path:
        return None
    out = subprocess.run([path, flag], capture_output=True, text=True, encoding="utf-8", errors="replace").stdout
    return out.splitlines()[0] if out else "?"


def api_key_set() -> bool:
    if os.environ.get("ANTHROPIC_API_KEY"):
        return True
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8", errors="replace").splitlines():
            key, _, val = line.partition("=")
            if key.strip() == "ANTHROPIC_API_KEY" and val.strip() and "your-key" not in val:
                return True
    return False


def main() -> int:
    ok = True
    py = sys.version_info
    py_ok = py >= (3, 11)
    print(f"[{'OK' if py_ok else 'MISSING'}] python {py.major}.{py.minor}.{py.micro} (need 3.11+)")
    ok &= py_ok
    for cmd, flag in [("node", "--version"), ("ffmpeg", "-version"), ("ffprobe", "-version"), ("yt-dlp", "--version")]:
        v = version_of(cmd, flag)
        print(f"[{'OK' if v else 'MISSING'}] {cmd}: {v or HINTS[cmd]}")
        ok &= bool(v)
    key = api_key_set()
    print(f"[{'OK' if key else 'MISSING'}] ANTHROPIC_API_KEY: {'set' if key else 'copy .env.example to .env and paste your key'}")
    ok &= key
    print("\nAll good." if ok else "\nFix the MISSING items above, then re-run.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
