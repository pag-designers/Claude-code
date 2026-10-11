"""Semi-automatic clipper: download a VOD, find candidate moments, render vertical clips.

Steps (run in order):
  download    fetch the VOD with yt-dlp into work/source.mp4
  transcribe  speech-to-text with faster-whisper into work/transcript.json (optional)
  candidates  score fixed-length windows by audio energy, speech and keywords -> work/candidates.csv
  review      you set approved=yes and edit title/post_caption in work/candidates.csv
  cut         render each approved row to 9:16 with subtitles and watermark -> out/
  check       verify captions and watermark rules before you post
"""
import argparse
import csv
import json
import os
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
# CLIPPER_WORK / CLIPPER_CONFIG let one install handle several campaigns and sources
WORK = Path(os.environ.get("CLIPPER_WORK", HERE / "work"))
OUT = Path(os.environ.get("CLIPPER_OUT", HERE / "out"))
SOURCE = WORK / "source.mp4"
TRANSCRIPT = WORK / "transcript.json"
CANDIDATES = WORK / "candidates.csv"
CAND_FIELDS = ["id", "start", "end", "score", "keyword_hits", "snippet",
               "approved", "title", "post_caption"]


def load_config():
    return json.loads(Path(os.environ.get("CLIPPER_CONFIG", HERE / "config.json")).read_text())


def norm(text):
    """Lowercase and strip accents, so 'Capítulo' matches 'capitulo'."""
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()


def fmt_ts(seconds):
    h, rem = divmod(int(seconds), 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def run(cmd):
    subprocess.run(cmd, check=True)


def cmd_download(args):
    cfg = load_config()
    WORK.mkdir(exist_ok=True)
    url = args.url or cfg["source_url"]
    h = cfg["download_max_height"]
    run([
        sys.executable, "-m", "yt_dlp",
        "-f", f"bv*[height<={h}]+ba/b[height<={h}]",
        "--merge-output-format", "mp4",
        "-o", str(SOURCE), url,
    ])
    print(f"saved {SOURCE}")


def cmd_transcribe(args):
    from faster_whisper import WhisperModel

    cfg = load_config()
    model = WhisperModel(cfg["whisper_model"], device="cpu", compute_type="int8")
    # decode audio with ffmpeg and hand Whisper the samples; avoids the PyAV path
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(SOURCE), "-vn", "-ac", "1",
                          "-ar", "16000", "-f", "f32le", "-"], check=True, capture_output=True).stdout
    audio = np.frombuffer(raw, dtype=np.float32)
    segments, info = model.transcribe(audio, language=cfg.get("language"),
                                      vad_filter=True, word_timestamps=True)
    out = []
    for seg in segments:
        out.append({
            "start": round(seg.start, 2),
            "end": round(seg.end, 2),
            "text": seg.text.strip(),
            "words": [w.word for w in (seg.words or [])],
        })
        if len(out) % 200 == 0:
            print(f"  {fmt_ts(seg.end)} transcribed", flush=True)
    TRANSCRIPT.write_text(json.dumps({"language": info.language, "segments": out}, indent=1))
    print(f"wrote {len(out)} segments to {TRANSCRIPT}")


def audio_energy(path):
    """Per-second RMS loudness for the whole file, read in chunks to keep memory low."""
    proc = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", "8000",
         "-f", "s16le", "-"],
        stdout=subprocess.PIPE,
    )
    rates = []
    chunk = 8000 * 600  # 10 minutes of audio per read
    while True:
        raw = proc.stdout.read(chunk * 2)
        if not raw:
            break
        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32)
        usable = (len(samples) // 8000) * 8000
        per_sec = samples[:usable].reshape(-1, 8000)
        rates.append(np.sqrt((per_sec ** 2).mean(axis=1)))
    proc.wait()
    return np.concatenate(rates) if rates else np.zeros(0)


def cmd_candidates(args):
    cfg = load_config()
    if not SOURCE.exists():
        sys.exit("No source video. Run: download")
    print("measuring audio energy (this takes a while on long VODs)...", flush=True)
    rms = audio_energy(SOURCE)
    z = (rms - rms.mean()) / (rms.std() + 1e-9)

    words_per_sec = np.zeros(len(rms))
    keyword_at = np.zeros(len(rms))
    transcript = None
    if TRANSCRIPT.exists():
        transcript = json.loads(TRANSCRIPT.read_text())["segments"]
        kw = [k.lower() for k in cfg["keywords"]]
        for seg in transcript:
            s, e = int(seg["start"]), min(int(seg["end"]) + 1, len(rms))
            if s >= len(rms):
                continue
            n_words = len(seg["text"].split())
            words_per_sec[s:e] += n_words / max(1, e - s)
            if any(k in seg["text"].lower() for k in kw):
                keyword_at[s] += 1

    L = cfg["clip_seconds"]
    step = cfg["scan_step_seconds"]
    scored = []
    for start in range(0, max(1, len(z) - L), step):
        end = start + L
        window_z = z[start:end]
        score = float(window_z.mean() + 0.5 * np.percentile(window_z, 90))
        if transcript is not None:
            score += 0.3 * float(words_per_sec[start:end].mean()) / 3.0
        hits = int(keyword_at[start:end].sum())
        score += 0.5 * min(hits, 4)
        scored.append((score, start, hits))
    scored.sort(reverse=True)

    picked = []
    for score, start, hits in scored:
        if all(abs(start - p["start"]) >= L for p in picked):
            picked.append({"start": start, "score": score, "hits": hits})
        if len(picked) >= args.n:
            break
    picked.sort(key=lambda p: p["start"])

    rows = []
    for i, p in enumerate(picked, 1):
        snippet = ""
        if transcript:
            parts = [s["text"] for s in transcript
                     if s["end"] > p["start"] and s["start"] < p["start"] + L]
            snippet = " ".join(parts)[:300]
        rows.append({
            "id": f"c{i:02d}", "start": fmt_ts(p["start"]), "end": fmt_ts(p["start"] + L),
            "score": round(p["score"], 2), "keyword_hits": p["hits"], "snippet": snippet,
            "approved": "", "title": "", "post_caption": "",
        })
    with CANDIDATES.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=CAND_FIELDS)
        w.writeheader()
        w.writerows(rows)
    print(f"wrote {len(rows)} candidates to {CANDIDATES}")
    if transcript is None:
        print("note: no transcript found, so scores use audio energy only")


def to_seconds(ts):
    h, m, s = ts.split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)


def censor(text, words):
    """Star out profanity, keeping the first letter: 'cabrón' -> 'c*****'."""
    text = text.replace("[&nbsp;__&nbsp;]", "***").replace("[ __ ]", "***")
    for w in words:
        text = re.sub(rf"\b{re.escape(w)}\w*", lambda m: m.group(0)[0] + "*" * (len(m.group(0)) - 1),
                      text, flags=re.IGNORECASE)
    return text


def write_srt(segments, start, end, path, censor_words=()):
    """Subtitle lines overlapping [start, end), shifted so the clip starts at 0."""
    lines = []
    n = 0
    for seg in segments:
        if seg["end"] <= start or seg["start"] >= end:
            continue
        n += 1
        s = max(0.0, seg["start"] - start)
        e = min(end - start, seg["end"] - start)
        lines.append(f"{n}\n{_srt_time(s)} --> {_srt_time(e)}\n{censor(seg['text'], censor_words)}\n")
    path.write_text("\n".join(lines), encoding="utf-8")
    return n


def _srt_time(t):
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def cmd_cut(args):
    cfg = load_config()
    if not SOURCE.exists():
        sys.exit("No source video. Run: download")
    if not CANDIDATES.exists():
        sys.exit("No candidates yet. Run: candidates")
    wm_path = HERE / cfg["watermark"]["path"] if cfg["watermark"] else None
    if cfg["watermark"] and not wm_path.exists():
        sys.exit(f"Missing watermark at {wm_path}. Add the watermark PNG there first.")
    segments = json.loads(TRANSCRIPT.read_text())["segments"] if TRANSCRIPT.exists() else None

    rows = list(csv.DictReader(CANDIDATES.open()))
    todo = [r for r in rows if r["approved"].strip().lower() == "yes"]
    if not todo:
        sys.exit("No rows with approved=yes in work/candidates.csv")
    OUT.mkdir(exist_ok=True)

    for r in todo:
        start = to_seconds(r["start"])
        end = to_seconds(r["end"])
        dur = end - start
        wm = cfg["watermark"]  # None means no watermark (campaigns that ban them)
        sub_filter = ""
        if segments is not None:
            srt = WORK / f"{r['id']}.srt"
            count = write_srt(segments, start, end, srt, cfg.get("censor_words", []))
            if count:
                st = cfg["subtitles"]
                style = f"FontName=Arial,Bold=1,FontSize={st['font_size']},Alignment=2,MarginV={st['margin_v']}"
                sub_filter = f";[v1]subtitles={srt.name}:force_style='{style}'[v2]"
        base = "[0:v]split[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=25[bg];[b]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2[v0]"
        if wm:
            wm_chain = f";[1:v]scale={int(1080 * wm['width_ratio'])}:-1,format=rgba[wm];[v0][wm]overlay={wm['x']}:{wm['y']}[v1]"
        else:
            wm_chain = ";[v0]null[v1]"
        graph = base + wm_chain + sub_filter
        final_label = "[v2]" if sub_filter else "[v1]"
        out_path = OUT / f"{r['id']}.mp4"
        cmd = [
            "ffmpeg", "-y", "-v", "error", "-ss", str(start), "-t", str(dur),
            "-i", str(SOURCE), *(["-i", str(wm_path)] if wm_path else []),
            "-filter_complex", graph, "-map", final_label, "-map", "0:a?",
            "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
            str(out_path),
        ]
        # subtitles are resolved relative to WORK, where the .srt files live
        if subprocess.run(cmd, cwd=WORK).returncode != 0:
            print(f"failed: {r['id']}")
            continue
        print(f"rendered {out_path}")


def cmd_check(args):
    cfg = load_config()
    rows = list(csv.DictReader(CANDIDATES.open()))
    problems = 0
    for r in rows:
        if r["approved"].strip().lower() != "yes":
            continue
        cap = norm(r["post_caption"])
        for phrase in cfg.get("caption_must_contain", []):
            if norm(phrase) not in cap:
                print(f"{r['id']}: caption must contain '{phrase}'")
                problems += 1
        for word in cfg.get("banned_words", []):
            if norm(word) in cap:
                print(f"{r['id']}: caption contains banned word '{word}'")
                problems += 1
        if not (OUT / f"{r['id']}.mp4").exists():
            print(f"{r['id']}: not rendered yet")
            problems += 1
    print("all approved clips pass" if problems == 0 else f"{problems} problem(s) found")
    return 1 if problems else 0


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("download"); d.add_argument("--url"); d.set_defaults(fn=cmd_download)
    sub.add_parser("transcribe").set_defaults(fn=cmd_transcribe)
    c = sub.add_parser("candidates"); c.add_argument("--n", type=int, default=15); c.set_defaults(fn=cmd_candidates)
    sub.add_parser("cut").set_defaults(fn=cmd_cut)
    sub.add_parser("check").set_defaults(fn=cmd_check)
    args = p.parse_args()
    rc = args.fn(args)
    sys.exit(rc or 0)


if __name__ == "__main__":
    main()
