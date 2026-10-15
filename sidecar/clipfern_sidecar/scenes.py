from __future__ import annotations

import os
import time

from .schemas import SceneSpan, ScenesRequest, ScenesResponse


def detect_scenes(req: ScenesRequest) -> ScenesResponse:
    from scenedetect import AdaptiveDetector, ContentDetector, SceneManager, open_video

    if not os.path.isfile(req.video_path):
        raise FileNotFoundError(f"Video file not found: {req.video_path}")
    started = time.monotonic()
    video = open_video(req.video_path)
    fps = float(video.frame_rate)
    min_len = max(1, int(round(req.min_scene_len_s * fps)))
    if req.detector == "adaptive":
        detector = AdaptiveDetector(
            adaptive_threshold=req.threshold if req.threshold is not None else 3.0,
            min_scene_len=min_len,
        )
    else:
        detector = ContentDetector(
            threshold=req.threshold if req.threshold is not None else 27.0,
            min_scene_len=min_len,
        )
    manager = SceneManager()
    manager.add_detector(detector)
    manager.detect_scenes(video, show_progress=False)
    scene_list = manager.get_scene_list(start_in_scene=True)
    scenes = [SceneSpan(start=round(a.seconds, 3), end=round(b.seconds, 3)) for a, b in scene_list]
    cuts = [s.start for s in scenes[1:]]
    duration = scenes[-1].end if scenes else round(float(video.duration.seconds), 3)
    return ScenesResponse(
        duration=duration,
        fps=round(fps, 3),
        detector=req.detector,
        cuts=cuts,
        scenes=scenes,
        elapsed_s=round(time.monotonic() - started, 3),
    )
