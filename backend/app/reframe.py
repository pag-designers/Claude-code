"""Face / active-speaker analysis (MediaPipe) → 9:16 layout plan (track one face, split two, or fit)."""
import re
import subprocess
import urllib.request
from pathlib import Path

import cv2
import numpy as np

from . import store
from .config import MODELS, video_dir

MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"
SAMPLE_FPS = 3
ANALYSIS_WIDTH = 960


def _model_path() -> Path:
    p = MODELS / "face_landmarker.task"
    if not p.exists():  # download to .part first so an interrupted download is retried next time
        tmp = p.with_suffix(".part")
        urllib.request.urlretrieve(MODEL_URL, tmp)
        store.replace_retry(tmp, p)
    return p


def _landmarker():
    from mediapipe.tasks.python import BaseOptions, vision
    opts = vision.FaceLandmarkerOptions(
        # Pass the bytes, not the path: MediaPipe on Windows can't open paths with accents (C:\\Users\\José).
        base_options=BaseOptions(model_asset_buffer=_model_path().read_bytes()),
        running_mode=vision.RunningMode.IMAGE, num_faces=3,
        min_face_detection_confidence=0.5, min_face_presence_confidence=0.5)
    return vision.FaceLandmarker.create_from_options(opts)


def _tiles(w: int, h: int) -> list[tuple[int, int, int, int]]:
    """Full frame + overlapping square tiles. MediaPipe's face model is tuned for close-ups, so small faces
    in podcast grids / wide shots are only found when we zoom into part of the frame."""
    if w <= h:
        return [(0, 0, w, h)]
    return [(0, 0, w, h)] + [(int(x), 0, h, h) for x in (0, (w - h) / 2, w - h)]


def _merge(faces: list[tuple]) -> list[tuple]:
    out: list[tuple] = []
    for f in faces:
        cx, cy = (f[0] + f[2]) / 2, (f[1] + f[3]) / 2
        if all(abs(cx - (g[0] + g[2]) / 2) > 0.06 or abs(cy - (g[1] + g[3]) / 2) > 0.08 for g in out):
            out.append(f)
    return out


def _detector():
    """MediaPipe FaceLandmarker (faces + mouth movement), or OpenCV's bundled detector if MediaPipe can't load.
    Returns detect(rgb) -> [(x0, y0, x1, y1, mouth_open)] in 0..1 coordinates, and a close() function."""
    try:
        import mediapipe as mp
        lm = _landmarker()

        def detect(rgb):
            h, w = rgb.shape[:2]
            found = []
            for x0, y0, tw, th in _tiles(w, h):
                crop = np.ascontiguousarray(rgb[y0:y0 + th, x0:x0 + tw])
                for pts in lm.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=crop)).face_landmarks:
                    xs = [(x0 + p.x * tw) / w for p in pts]
                    ys = [(y0 + p.y * th) / h for p in pts]
                    face_h = abs(pts[152].y - pts[10].y) or 1e-3
                    found.append((min(xs), min(ys), max(xs), max(ys), abs(pts[14].y - pts[13].y) / face_h))
            return _merge(found)
        return detect, lm.close
    except Exception:  # e.g. missing libEGL on a headless Linux box
        cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
        if cascade.empty():  # e.g. a non-ASCII install path on Windows: read it through a FileStorage-free route
            import shutil, tempfile
            tmp = Path(tempfile.gettempdir()) / "clipper_haar.xml"
            shutil.copyfile(cv2.data.haarcascades + "haarcascade_frontalface_default.xml", tmp)
            cascade = cv2.CascadeClassifier(str(tmp))

        def detect(rgb):
            gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
            h, w = gray.shape
            boxes = cascade.detectMultiScale(gray, 1.15, 6, minSize=(w // 25, w // 25))
            return [(x / w, y / h, (x + bw) / w, (y + bh) / h, 0.0) for x, y, bw, bh in boxes]
        return detect, lambda: None


def sample_faces(video_id: str, start: float, end: float) -> list[dict]:
    """Faces every 1/SAMPLE_FPS s: normalized box, center, and mouth openness. Cached per range."""
    key = f"faces_{start:.2f}_{end:.2f}"
    cached = store.load(video_id, key)
    if cached is not None:
        return cached
    cap = cv2.VideoCapture(str(video_dir(video_id) / "source.mp4"))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    cap.set(cv2.CAP_PROP_POS_MSEC, start * 1000)
    step = max(1, round(fps / SAMPLE_FPS))
    samples, frame_no = [], 0
    detect, close = _detector()
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            t = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000
            if t > end:
                break
            frame_no += 1
            if t < start or (frame_no - 1) % step:
                continue
            h, w = frame.shape[:2]
            small = cv2.resize(frame, (ANALYSIS_WIDTH, int(h * ANALYSIS_WIDTH / w)))
            faces = [{"cx": round((x0 + x1) / 2, 4), "cy": round((y0 + y1) / 2, 4), "w": round(x1 - x0, 4),
                      "h": round(y1 - y0, 4), "mouth": round(m, 4)}
                     for x0, y0, x1, y1, m in detect(cv2.cvtColor(small, cv2.COLOR_BGR2RGB))]
            samples.append({"t": round(t, 3), "faces": faces})
    finally:
        close()
        cap.release()
    store.save(video_id, key, samples)
    return samples


def build_tracks(samples: list[dict], max_dist: float = 0.12) -> list[dict]:
    """Link per-frame faces into tracks by nearest center. Returns tracks sorted by presence."""
    tracks: list[dict] = []
    for si, s in enumerate(samples):
        used = set()
        for f in s["faces"]:
            best, best_d = None, max_dist
            for k, tr in enumerate(tracks):
                if k in used:
                    continue
                d = np.hypot(tr["cx"] - f["cx"], tr["cy"] - f["cy"])
                if d < best_d:
                    best, best_d = k, d
            if best is None:
                tracks.append({"cx": f["cx"], "cy": f["cy"], "points": []})
                best = len(tracks) - 1
            tr = tracks[best]
            used.add(best)
            tr["points"].append({**f, "t": s["t"], "si": si})
            tr["cx"], tr["cy"] = 0.7 * tr["cx"] + 0.3 * f["cx"], 0.7 * tr["cy"] + 0.3 * f["cy"]
    n = max(len(samples), 1)
    for tr in tracks:
        pts = tr["points"]
        tr["presence"] = len(pts) / n
        tr["cx"] = float(np.median([p["cx"] for p in pts]))
        tr["cy"] = float(np.median([p["cy"] for p in pts]))
        tr["w"] = float(np.median([p["w"] for p in pts]))
        tr["h"] = float(np.median([p["h"] for p in pts]))
        mouths = [p["mouth"] for p in pts]
        tr["talk"] = float(np.std(mouths)) if len(mouths) > 2 else 0.0  # mouth movement ≈ speaking
    return sorted(tracks, key=lambda tr: tr["presence"], reverse=True)


def scene_cuts(video_id: str, start: float, end: float, threshold: float = 0.12) -> list[float]:
    """Exact shot changes inside [start, end] (camera switch, grid ↔ solo). Cached."""
    key = f"cuts_{start:.2f}_{end:.2f}"
    cached = store.load(video_id, key)
    if cached is not None:
        return cached
    p = subprocess.run(["ffmpeg", "-v", "info", "-ss", f"{start:.3f}", "-t", f"{end - start:.3f}",
                        "-i", str(video_dir(video_id) / "source.mp4"), "-an",
                        "-vf", f"scale=320:-2,select='gt(scene,{threshold})',showinfo", "-f", "null", "-"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    raw = [round(start + float(t), 3) for t in re.findall(r"pts_time:([\d.]+)", p.stderr)]
    cuts: list[float] = []  # animated transitions trigger several frames in a row: keep the last of each burst
    for c in raw:
        if cuts and c - cuts[-1] < 0.6:
            cuts[-1] = c
        else:
            cuts.append(c)
    store.save(video_id, key, cuts)
    return cuts


def shots(video_id: str, start: float, end: float, min_len: float = 1.0) -> list[tuple[float, float]]:
    """Split a clip into shots at scene cuts; very short shots are merged into the previous one."""
    edges = [start] + [c for c in scene_cuts(video_id, start, end) if start + min_len < c < end - min_len] + [end]
    out: list[tuple[float, float]] = []
    for s, e in zip(edges, edges[1:]):
        if out and e - s < min_len:
            out[-1] = (out[-1][0], e)
        else:
            out.append((s, e))
    return out


def plan(video_id: str, start: float, end: float, prefer: str = "auto") -> list[dict]:
    """Layout plan per shot. prefer: auto | track | split | speaker | fit. Each item has s, e, layout, ..."""
    samples = sample_faces(video_id, start, end)
    out = []
    for s, e in shots(video_id, start, end):
        sub = [x for x in samples if s <= x["t"] < e]
        out.append({"s": s, "e": e, **plan_shot(sub, s, e, prefer)})
    return out


def plan_shot(samples: list[dict], start: float, end: float, prefer: str) -> dict:
    tracks = [tr for tr in build_tracks(samples) if tr["presence"] >= 0.4 and tr["w"] > 0.03]
    if prefer == "fit" or not tracks:
        return {"layout": "fit", "tracks": []}
    if prefer in ("split", "auto") and len(tracks) >= 2:
        top2 = sorted(sorted(tracks, key=lambda tr: tr["talk"], reverse=True)[:2], key=lambda tr: tr["cx"])
        return {"layout": "split", "tracks": [_slim(tr) for tr in top2]}
    if prefer == "speaker" and len(tracks) >= 2:
        return {"layout": "speaker", "tracks": [_slim(tr) for tr in tracks[:4]],
                "segments": speaker_segments(tracks[:4], start, end)}
    main = max(tracks, key=lambda tr: tr["presence"] + tr["talk"] * 5)
    return {"layout": "track", "tracks": [_slim(main)], "path": [(p["t"], p["cx"], p["cy"]) for p in main["points"]]}


def _slim(tr: dict) -> dict:
    return {k: round(tr[k], 4) for k in ("cx", "cy", "w", "h", "presence", "talk")}


def speaker_segments(tracks: list[dict], start: float, end: float, window: float = 1.5, hold: float = 2.0) -> list[tuple[float, int]]:
    """Who is talking when: for each window pick the track whose mouth moves most; hold each pick ≥ `hold` s."""
    segs: list[tuple[float, int]] = []
    t = start
    while t < end:
        best, best_v = None, 0.004
        for k, tr in enumerate(tracks):
            m = [p["mouth"] for p in tr["points"] if t <= p["t"] < t + window]
            if len(m) >= 3 and np.std(m) > best_v:
                best, best_v = k, float(np.std(m))
        if best is not None and (not segs or (segs[-1][1] != best and t - segs[-1][0] >= hold)):
            segs.append((round(t, 2), best))
        t += window / 2
    return segs or [(start, 0)]
