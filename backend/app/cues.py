"""Non-dialogue cues fed to the AI: loudness peaks (excitement/laughter), scene changes, transcript reactions."""
import re
import subprocess

import numpy as np

from . import store
from .config import video_dir
from .transcribe import _read_wav

REACTION = re.compile(r"\b(ha(ha)+|lol|laugh\w*|risas?|jaja(ja)*|wow|oh my god|no way|what\?!)\b|\[(.*?)\]|\((.*?)\)", re.I)


def loudness(video_id: str, hop: float = 0.5) -> list[float]:
    """RMS loudness in dB, one value per `hop` seconds."""
    x, sr = _read_wav(video_dir(video_id) / "audio.wav")
    n = int(hop * sr)
    frames = x[: len(x) // n * n].reshape(-1, n)
    rms = np.sqrt((frames ** 2).mean(1) + 1e-12)
    return np.round(20 * np.log10(rms), 1).tolist()


def scene_changes(video_id: str, threshold: float = 0.35) -> list[float]:
    """Timestamps where the picture changes a lot (camera switch, screen share, cut)."""
    src = video_dir(video_id) / "source.mp4"
    p = subprocess.run(
        ["ffmpeg", "-v", "info", "-skip_frame", "nokey", "-i", str(src), "-vf",
         f"scale=160:-2,select='gt(scene,{threshold})',showinfo", "-an", "-f", "null", "-"],
        capture_output=True, text=True, encoding="utf-8", errors="replace")
    return [round(float(t), 2) for t in re.findall(r"pts_time:([\d.]+)", p.stderr)]


def compute(video_id: str) -> dict:
    cached = store.load(video_id, "cues")
    if cached:
        return cached
    hop = 0.5
    loud = loudness(video_id, hop)
    arr = np.array(loud)
    voiced = arr[arr > -50]
    # A "peak" is ≥ 6 dB louder than the median voiced level: shouting, laughter, applause.
    peak_level = float(np.median(voiced) + 6) if len(voiced) else 0.0
    peaks = [round(i * hop, 1) for i, v in enumerate(loud) if v >= peak_level]
    scenes = scene_changes(video_id)
    t = store.load(video_id, "transcript", {})
    reactions = [w["s"] for w in t.get("words", []) if REACTION.search(w["w"])]
    cues = {"hop": hop, "loudness": loud, "peak_level": round(peak_level, 1), "peaks": peaks,
            "scenes": scenes, "reactions": reactions}
    store.save(video_id, "cues", cues)
    return cues


def sentence_tags(sentence: dict, cues: dict) -> list[str]:
    """Short tags shown next to each transcript line in prompts, e.g. ['LOUD', 'SCENE']."""
    s, e = sentence["s"], sentence["e"]
    tags = []
    if sum(1 for p in cues.get("peaks", []) if s <= p <= e) >= 2:
        tags.append("LOUD")
    if any(s - 0.5 <= r <= e for r in cues.get("reactions", [])):
        tags.append("REACTION")
    if any(s <= c <= e for c in cues.get("scenes", [])):
        tags.append("SCENE")
    return tags
