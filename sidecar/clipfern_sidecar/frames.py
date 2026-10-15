"""Frame scoring for thumbnails: sharpness, exposure and faces for a batch of still images.

Used by the thumbnail picker (`POST /frames/score`): the caller extracts ~8 candidate frames of a clip
and gets back everything it needs to rank them (the ranking itself lives in the app).
"""

from __future__ import annotations

import os
import threading
import time

from . import paths
from .faces import detect_tiles, nms, to_face_boxes
from .schemas import FrameScore, FramesScoreRequest, FramesScoreResponse

_SCORE_WIDTH = 640
_lock = threading.Lock()
_detectors: dict[float, object] = {}


def _detector(min_confidence: float):
    """One lazily created IMAGE-mode detector per confidence threshold (loading takes ~100 ms)."""
    from mediapipe.tasks.python import BaseOptions, vision

    key = round(min_confidence, 2)
    det = _detectors.get(key)
    if det is None:
        det = vision.FaceDetector.create_from_options(
            vision.FaceDetectorOptions(
                base_options=BaseOptions(model_asset_path=str(paths.face_model_path())),
                running_mode=vision.RunningMode.IMAGE,
                min_detection_confidence=key,
            )
        )
        _detectors[key] = det
    return det


def score_frames(req: FramesScoreRequest) -> FramesScoreResponse:
    import cv2
    import mediapipe as mp
    import numpy as np

    for f in req.files:
        if not os.path.isfile(f):
            raise FileNotFoundError(f"Image file not found: {f}")
    if not paths.face_model_ready():
        raise FileNotFoundError(
            "Face detector model is not downloaded. Run bootstrap/download_face_model.py first."
        )
    started = time.monotonic()
    out: list[FrameScore] = []
    with _lock:  # a MediaPipe task object is not re-entrant
        det = _detector(req.min_confidence)
        for path in req.files:
            bgr = cv2.imread(path, cv2.IMREAD_COLOR)
            if bgr is None:
                raise ValueError(f"Could not read image: {path}")
            h, w = bgr.shape[:2]
            gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
            if w != _SCORE_WIDTH:
                gray = cv2.resize(gray, (_SCORE_WIDTH, max(1, round(h * _SCORE_WIDTH / w))), interpolation=cv2.INTER_AREA)
            sharp = float(cv2.Laplacian(gray, cv2.CV_64F).var())
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            if max(w, h) > 1280:
                s = 1280 / max(w, h)
                rgb = cv2.resize(rgb, (max(1, int(w * s)), max(1, int(h * s))), interpolation=cv2.INTER_AREA)
            rgb = np.ascontiguousarray(rgb)
            result = det.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
            faces = to_face_boxes(result, rgb.shape[1], rgb.shape[0])
            if req.small_faces:
                faces = nms(faces + detect_tiles(det.detect, rgb, mp))
            faces = [f for f in faces if f.score >= req.min_confidence]
            faces.sort(key=lambda b: b.score, reverse=True)
            out.append(
                FrameScore(
                    file=path,
                    width=w,
                    height=h,
                    sharpness=round(sharp, 3),
                    brightness=round(float(gray.mean()) / 255.0, 4),
                    contrast=round(float(gray.std()) / 255.0, 4),
                    faces=faces,
                )
            )
    return FramesScoreResponse(frames=out, elapsed_s=round(time.monotonic() - started, 3))
