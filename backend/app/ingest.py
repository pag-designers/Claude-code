"""Get a video onto disk: YouTube/URL via yt-dlp, or an uploaded/local file. Then probe it and extract audio."""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

from . import store
from .config import ROOT, video_dir

# Run yt-dlp through this same Python ("python -m yt_dlp"): works on Windows/Mac/Linux without PATH setup.
YTDLP = [sys.executable, "-m", "yt_dlp"]
# Child processes print UTF-8 (video titles can contain any language/emoji); Windows' default code page can't.
TEXT = {"text": True, "encoding": "utf-8", "errors": "replace"}
UTF8_ENV = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    try:
        p = subprocess.run(cmd, capture_output=True, **TEXT, **kw)
    except FileNotFoundError:
        raise RuntimeError(f"Could not start '{cmd[0]}'. Is it installed? (run scripts/doctor.py to check)") from None
    if p.returncode != 0:
        raise RuntimeError(f"{Path(cmd[0]).name} failed: {(p.stderr or p.stdout)[-1500:]}")
    return p


def youtube_id(url: str) -> str | None:
    m = re.search(r"(?:v=|youtu\.be/|shorts/|live/|embed/)([\w-]{11})", url)
    return m.group(1) if m else None


def video_id_for_url(url: str) -> str:
    yid = youtube_id(url)
    return f"yt_{yid}" if yid else "url_" + hashlib.sha1(url.encode()).hexdigest()[:12]


def video_id_for_file(path: Path) -> str:
    # Hash size + first 4 MB: fast, and the same file always maps to the same cache folder.
    h = hashlib.sha1(str(path.stat().st_size).encode())
    with open(path, "rb") as f:
        h.update(f.read(4 << 20))
    return "up_" + h.hexdigest()[:12]


def probe(path: Path) -> dict:
    out = run(["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(path)]).stdout
    info = json.loads(out)
    v = next((s for s in info["streams"] if s["codec_type"] == "video"), None)
    if v is None:
        raise RuntimeError("No video stream found in the file.")
    num, _, den = v.get("r_frame_rate", "30/1").partition("/")
    fps = float(num) / float(den or 1) if float(den or 1) else 30.0
    return {
        "duration": float(info["format"]["duration"]),
        "width": int(v["width"]),
        "height": int(v["height"]),
        "fps": round(fps, 3),
        "has_audio": any(s["codec_type"] == "audio" for s in info["streams"]),
    }


def download_url(url: str, video_id: str, on_progress=None) -> dict:
    """Download best ≤1080p MP4 with yt-dlp. Returns metadata. Cached: re-runs skip the download."""
    d = video_dir(video_id)
    src = d / "source.mp4"
    meta = store.load(video_id, "meta", {})
    if src.exists() and meta.get("duration"):
        return meta
    cmd = [
        *YTDLP, "--js-runtimes", "node", "--no-playlist", "--newline",
        "-f", "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b",
        "--merge-output-format", "mp4", "-o", str(d / "source.%(ext)s"),
        "--print-json", "--no-simulate", "--progress", url,
    ]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd=ROOT, env=UTF8_ENV, **TEXT)
    info, tail = {}, []
    for line in p.stdout:  # type: ignore[union-attr]
        tail = (tail + [line])[-30:]
        if line.startswith("{"):
            try:
                info = json.loads(line)
            except json.JSONDecodeError:
                pass
        m = re.search(r"\[download\]\s+([\d.]+)%", line)
        if m and on_progress:
            on_progress(float(m.group(1)) / 100)
    if p.wait() != 0 or not src.exists():
        msg = "".join(tail)
        if "confirm you" in msg and "bot" in msg:
            msg = ("YouTube blocked this download (bot check). This happens on cloud/datacenter IPs; "
                   "run Clipper on your own computer, or download the video and upload the file.\n" + msg)
        raise RuntimeError(msg[-2000:])
    meta = {"id": video_id, "source_url": url, "title": info.get("title") or url,
            "channel": info.get("channel") or info.get("uploader"), **probe(src)}
    store.save(video_id, "meta", meta)
    return meta


def import_file(path: Path, title: str | None = None, move: bool = False) -> dict:
    """Copy (or move) a local/uploaded file into the cache."""
    video_id = video_id_for_file(path)
    d = video_dir(video_id)
    src = d / "source.mp4"
    if not src.exists():
        if path.suffix.lower() == ".mp4":
            (shutil.move if move else shutil.copy2)(str(path), src)
        else:  # remux other containers to mp4 (no re-encode when codecs allow)
            try:
                run(["ffmpeg", "-v", "error", "-y", "-i", str(path), "-c", "copy", "-movflags", "+faststart", str(src)])
            except RuntimeError:
                run(["ffmpeg", "-v", "error", "-y", "-i", str(path), "-c:v", "libx264", "-preset", "veryfast",
                     "-crf", "20", "-c:a", "aac", str(src)])
    meta = store.load(video_id, "meta") or {"id": video_id, "source_url": None, "title": title or path.stem,
                                            "channel": None, **probe(src)}
    store.save(video_id, "meta", meta)
    return meta


def extract_audio(video_id: str) -> Path:
    """16 kHz mono WAV: what Whisper wants, and cheap to analyse for loudness."""
    d = video_dir(video_id)
    wav = d / "audio.wav"
    if not wav.exists():
        run(["ffmpeg", "-v", "error", "-y", "-i", str(d / "source.mp4"), "-vn", "-ac", "1", "-ar", "16000",
             "-c:a", "pcm_s16le", str(wav)])
    return wav
