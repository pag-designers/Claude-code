"""Face detection with the MediaPipe Tasks API (BlazeFace short-range, VIDEO running mode).

`mp.solutions.*` no longer exists in mediapipe >= 0.10.2x, so this uses
`mediapipe.tasks.python.vision.FaceDetector` with a downloaded .tflite model.
"""

from __future__ import annotations

import math
import os
import time

from . import paths
from .schemas import FaceBox, FaceFrame, FacesRequest, FacesResponse

_DETECT_MAX_WIDTH = 640
#: Small-face search: 3x3 grid of half-frame tiles (stride 1/4) on top of the full-frame pass.
_TILE_FRAC = 0.5
_TILE_STRIDE = 0.25


def to_face_boxes(result, fw: int, fh: int, ox: int = 0, oy: int = 0, full_w: int | None = None, full_h: int | None = None) -> list[FaceBox]:
    """MediaPipe detections -> FaceBox normalised to the FULL image (a tile has offset ox/oy)."""
    full_w = full_w or fw
    full_h = full_h or fh
    faces: list[FaceBox] = []
    for det in result.detections:
        box = det.bounding_box
        score = det.categories[0].score if det.categories else 0.0
        x0 = max(0.0, (ox + box.origin_x) / full_w)
        y0 = max(0.0, (oy + box.origin_y) / full_h)
        x1 = min(1.0, (ox + box.origin_x + box.width) / full_w)
        y1 = min(1.0, (oy + box.origin_y + box.height) / full_h)
        faces.append(
            FaceBox(
                x=round(x0, 4),
                y=round(y0, 4),
                w=round(max(0.0, x1 - x0), 4),
                h=round(max(0.0, y1 - y0), 4),
                score=round(float(score), 4),
                keypoints=[
                    (round((ox + k.x * fw) / full_w, 4), round((oy + k.y * fh) / full_h, 4))
                    for k in det.keypoints
                ],
            )
        )
    return faces


def _iou(a: FaceBox, b: FaceBox) -> float:
    x0, y0 = max(a.x, b.x), max(a.y, b.y)
    x1, y1 = min(a.x + a.w, b.x + b.w), min(a.y + a.h, b.y + b.h)
    inter = max(0.0, x1 - x0) * max(0.0, y1 - y0)
    union = a.w * a.h + b.w * b.h - inter
    return inter / union if union > 0 else 0.0


def nms(faces: list[FaceBox], iou_thr: float = 0.35) -> list[FaceBox]:
    """Greedy non-maximum suppression, best score first."""
    kept: list[FaceBox] = []
    for f in sorted(faces, key=lambda b: b.score, reverse=True):
        if all(_iou(f, k) < iou_thr for k in kept):
            kept.append(f)
    return kept


def detect_tiles(detect_rgb, rgb_full, mp) -> list[FaceBox]:
    """Runs `detect_rgb(mp_image)` on a 3x3 grid of half-frame tiles; boxes in full-image coordinates."""
    fh, fw = rgb_full.shape[0], rgb_full.shape[1]
    tw, th = int(fw * _TILE_FRAC), int(fh * _TILE_FRAC)
    out: list[FaceBox] = []
    for iy in range(3):
        for ix in range(3):
            ox = int(ix * _TILE_STRIDE * fw)
            oy = int(iy * _TILE_STRIDE * fh)
            tile = rgb_full[oy : oy + th, ox : ox + tw]
            if tile.size == 0:
                continue
            image = mp.Image(image_format=mp.ImageFormat.SRGB, data=tile.copy())
            out.extend(to_face_boxes(detect_rgb(image), tw, th, ox, oy, fw, fh))
    return out


def detect_faces(req: FacesRequest) -> FacesResponse:
    import cv2
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions, vision

    if not os.path.isfile(req.video_path):
        raise FileNotFoundError(f"Video file not found: {req.video_path}")
    if not paths.face_model_ready():
        raise FileNotFoundError(
            "Face detector model is not downloaded. Run bootstrap/download_face_model.py first."
        )
    started = time.monotonic()
    cap = cv2.VideoCapture(req.video_path)
    if not cap.isOpened():
        raise ValueError(f"Could not open video: {req.video_path}")
    detector = vision.FaceDetector.create_from_options(
        vision.FaceDetectorOptions(
            base_options=BaseOptions(model_asset_path=str(paths.face_model_path())),
            running_mode=vision.RunningMode.VIDEO,
            min_detection_confidence=req.min_confidence,
        )
    )
    try:
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        src_fps = float(cap.get(cv2.CAP_PROP_FPS))
        if not math.isfinite(src_fps) or src_fps <= 0:
            src_fps = 30.0
        if req.start > 0:
            cap.set(cv2.CAP_PROP_POS_MSEC, req.start * 1000.0)
        index = int(cap.get(cv2.CAP_PROP_POS_FRAMES))
        interval = 1.0 / req.fps
        next_t = index / src_fps
        frames: list[FaceFrame] = []
        with_faces = 0
        while len(frames) < req.max_frames:
            t = index / src_fps
            if req.end is not None and t >= req.end:
                break
            if not cap.grab():
                break
            index += 1
            if t + 1e-6 < next_t:
                continue
            next_t = t + interval
            ok, bgr = cap.retrieve()
            if not ok or bgr is None:
                continue
            bgr_full = bgr
            if bgr.shape[1] > _DETECT_MAX_WIDTH:
                scale = _DETECT_MAX_WIDTH / bgr.shape[1]
                bgr = cv2.resize(bgr, (_DETECT_MAX_WIDTH, max(1, int(bgr.shape[0] * scale))))
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            result = detector.detect_for_video(image, int(t * 1000) * (10 if req.small_faces else 1))
            fh, fw = rgb.shape[0], rgb.shape[1]
            faces = to_face_boxes(result, fw, fh)
            if req.small_faces:
                # tiles from the ORIGINAL resolution frame so tiny faces keep their pixels
                rgb_full = cv2.cvtColor(bgr_full, cv2.COLOR_BGR2RGB)
                ts = int(t * 1000)
                # VIDEO mode needs strictly increasing timestamps: spread the 9 tile calls over 9 ms
                calls = iter(range(1, 10))
                faces = nms(
                    faces
                    + detect_tiles(
                        lambda im: detector.detect_for_video(im, ts * 10 + next(calls)), rgb_full, mp
                    )
                )
            if faces:
                with_faces += 1
            frames.append(FaceFrame(t=round(t, 3), faces=faces))
    finally:
        detector.close()
        cap.release()
    return FacesResponse(
        width=width,
        height=height,
        source_fps=round(src_fps, 3),
        sample_fps=req.fps,
        frames_sampled=len(frames),
        frames_with_faces=with_faces,
        frames=frames,
        elapsed_s=round(time.monotonic() - started, 3),
    )
