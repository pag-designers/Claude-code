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
            if bgr.shape[1] > _DETECT_MAX_WIDTH:
                scale = _DETECT_MAX_WIDTH / bgr.shape[1]
                bgr = cv2.resize(bgr, (_DETECT_MAX_WIDTH, max(1, int(bgr.shape[0] * scale))))
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            result = detector.detect_for_video(image, int(t * 1000))
            fh, fw = rgb.shape[0], rgb.shape[1]
            faces: list[FaceBox] = []
            for det in result.detections:
                box = det.bounding_box
                score = det.categories[0].score if det.categories else 0.0
                x0 = max(0.0, box.origin_x / fw)
                y0 = max(0.0, box.origin_y / fh)
                x1 = min(1.0, (box.origin_x + box.width) / fw)
                y1 = min(1.0, (box.origin_y + box.height) / fh)
                faces.append(
                    FaceBox(
                        x=round(x0, 4),
                        y=round(y0, 4),
                        w=round(max(0.0, x1 - x0), 4),
                        h=round(max(0.0, y1 - y0), 4),
                        score=round(float(score), 4),
                        keypoints=[(round(k.x, 4), round(k.y, 4)) for k in det.keypoints],
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
