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


# OpenCV (face tracking) can't decode AV1, and YouTube often serves AV1/VP9 first: prefer H.264.
YT_FORMAT = ["-f", "bv*[height<=1080]+ba/b[height<=1080]/b", "-S", "vcodec:h264,res:1080,acodec:m4a"]
DECODABLE = {"h264", "hevc", "mpeg4", "vp8", "vp9", "mjpeg"}


def _friendly_ytdlp_error(log: str) -> str:
    low = log.lower()
    if "confirm you" in low and "bot" in low:
        return ("YouTube blocked this download (bot check). Wait a bit and try again, or download the video another "
                "way and use Upload file.")
    if "private video" in low or "sign in to confirm your age" in low or "members-only" in low:
        return "This video is private, members-only or age-restricted. Download it another way and use Upload file."
    if "video unavailable" in low or "has been removed" in low:
        return "This video is unavailable (removed or blocked in your country)."
    if "unsupported url" in low:
        return "That link isn't a video page Clipper can open. Paste the video's own URL."
    if "403" in low or "forbidden" in low:
        return ("YouTube refused the download. Close Clipper and start run.bat again (it updates the downloader). "
                "Still failing? Download the video another way and use Upload file.")
    errors = [line for line in log.splitlines() if line.startswith("ERROR")]
    return (errors[-1] if errors else log.strip().splitlines()[-1] if log.strip() else "Download failed.")[:500]


def _ensure_decodable(src: Path) -> None:
    """Re-encode to H.264 if the video codec can't be read by the face tracker (e.g. AV1)."""
    out = run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name",
               "-of", "csv=p=0", str(src)]).stdout.strip()
    if out and out not in DECODABLE:
        tmp = src.with_name("source.part.mp4")
        run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(src), "-c:v", "libx264", "-preset", "veryfast",
             "-crf", "20", "-c:a", "aac", "-movflags", "+faststart", str(tmp)])
        store.replace_retry(tmp, src)


def download_url(url: str, video_id: str, on_progress=None) -> dict:
    """Download best ≤1080p MP4 (H.264 preferred) with yt-dlp. Returns metadata. Cached: re-runs skip it."""
    d = video_dir(video_id)
    src = d / "source.mp4"
    meta = store.load(video_id, "meta", {})
    if src.exists() and meta.get("duration"):
        return meta
    cmd = [*YTDLP, "--js-runtimes", "node", "--no-playlist", "--newline", *YT_FORMAT,
           "--merge-output-format", "mp4", "-o", str(d / "source.%(ext)s"),
           "--print-json", "--no-simulate", "--progress", url]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                         cwd=ROOT, env=UTF8_ENV, **TEXT)
    info, tail = {}, []
    for line in p.stdout:  # type: ignore[union-attr]
        if line.startswith("{"):  # the --print-json dump: metadata, never shown to the user
            try:
                info = json.loads(line)
            except json.JSONDecodeError:
                pass
            continue
        tail = (tail + [line])[-30:]
        m = re.search(r"\[download\]\s+([\d.]+)%", line)
        if m and on_progress:
            on_progress(float(m.group(1)) / 100)
    if p.wait() != 0 or not src.exists():
        raise RuntimeError(_friendly_ytdlp_error("".join(tail)))
    _ensure_decodable(src)
    meta = {"id": video_id, "source_url": url, "title": info.get("title") or url,
            "channel": info.get("channel") or info.get("uploader"), **probe(src)}
    store.save(video_id, "meta", meta)
    return meta


def import_file(path: Path, title: str | None = None, move: bool = False) -> dict:
    """Copy (or move) a local/uploaded file into the cache. Raises ValueError if it isn't a readable video."""
    video_id = video_id_for_file(path)
    d = video_dir(video_id)
    src = d / "source.mp4"
    try:
        if not src.exists():
            tmp = d / "source.part.mp4"  # never leave a half-written source.mp4 behind
            if path.suffix.lower() == ".mp4":
                (shutil.move if move else shutil.copy2)(str(path), tmp)
            else:  # remux other containers to mp4 (no re-encode when codecs allow)
                try:
                    run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(path), "-c", "copy",
                         "-movflags", "+faststart", str(tmp)])
                except RuntimeError:
                    run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(path), "-c:v", "libx264",
                         "-preset", "veryfast", "-crf", "20", "-c:a", "aac", str(tmp)])
            info = probe(tmp)
            if not info["has_audio"]:
                raise RuntimeError("no audio track")
            store.replace_retry(tmp, src)
            _ensure_decodable(src)
        meta = store.load(video_id, "meta") or {"id": video_id, "source_url": None, "title": title or path.stem,
                                                "channel": None, **probe(src)}
    except RuntimeError as e:
        shutil.rmtree(d, ignore_errors=True)
        reason = "it has no sound" if "no audio" in str(e) else "it may be damaged, still downloading, or not a video"
        raise ValueError(f"Clipper can't read this file ({reason}). Try another file.") from e
    store.save(video_id, "meta", meta)
    return meta


def extract_audio(video_id: str) -> Path:
    """16 kHz mono WAV: what Whisper wants, and cheap to analyse for loudness."""
    d = video_dir(video_id)
    wav = d / "audio.wav"
    if not wav.exists():  # write to .part first: a closed window mid-extraction must not leave a short WAV
        tmp = d / "audio.part.wav"
        run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(d / "source.mp4"), "-vn", "-ac", "1", "-ar", "16000",
             "-c:a", "pcm_s16le", str(tmp)])
        store.replace_retry(tmp, wav)
    return wav
