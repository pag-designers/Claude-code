from __future__ import annotations

from pydantic import BaseModel, Field

# ---------------------------------------------------------------- health


class HealthResponse(BaseModel):
    ok: bool
    version: str
    python: str
    platform: str
    #: Hardware accelerator present: cuda | mps | cpu.
    device: str
    #: Device faster-whisper runs on: cuda | cpu.
    whisper_device: str
    compute_type: str
    device_note: str | None
    default_model: str
    #: True once the default Whisper model is loaded in memory.
    model_loaded: bool
    loaded_models: list[str]
    #: True when the default model's files are on disk.
    model_downloaded: bool
    face_model_downloaded: bool
    versions: dict[str, str | None]


# ---------------------------------------------------------------- transcribe


class TranscribeRequest(BaseModel):
    audio_path: str = Field(description="Path to a 16 kHz mono WAV (any ffmpeg-readable audio works)")
    model: str | None = Field(default=None, description="Whisper model name; defaults to env")
    language: str | None = Field(default=None, description="ISO code; null = auto-detect")
    vad_filter: bool = True
    beam_size: int = Field(default=5, ge=1, le=10)
    initial_prompt: str | None = None
    condition_on_previous_text: bool = False


class Word(BaseModel):
    word: str
    start: float
    end: float
    probability: float


class Segment(BaseModel):
    id: int
    start: float
    end: float
    text: str
    avg_logprob: float
    no_speech_prob: float
    words: list[Word]


class TranscribeResponse(BaseModel):
    model: str
    device: str
    compute_type: str
    language: str
    language_probability: float
    duration: float
    duration_after_vad: float
    elapsed_s: float
    segments: list[Segment]


# ---------------------------------------------------------------- scenes


class ScenesRequest(BaseModel):
    video_path: str
    detector: str = Field(default="content", pattern="^(content|adaptive)$")
    threshold: float | None = Field(default=None, gt=0, description="Detector threshold override")
    min_scene_len_s: float = Field(default=0.6, ge=0.0, le=60.0)


class SceneSpan(BaseModel):
    start: float
    end: float


class ScenesResponse(BaseModel):
    duration: float
    fps: float
    detector: str
    #: Times (seconds) at which a hard cut / scene change starts. Empty = single shot.
    cuts: list[float]
    scenes: list[SceneSpan]
    elapsed_s: float


# ---------------------------------------------------------------- faces


class FacesRequest(BaseModel):
    video_path: str
    fps: float = Field(default=2.0, gt=0, le=30)
    start: float = Field(default=0.0, ge=0)
    end: float | None = Field(default=None, gt=0)
    min_confidence: float = Field(default=0.5, ge=0, le=1)
    max_frames: int = Field(default=20000, ge=1, le=200000)
    #: Also search overlapping zoomed tiles (3x3 grid of half-frame crops) for SMALL faces such as a
    #: webcam overlay or video-call tiles. ~9x more detector calls; off by default.
    small_faces: bool = False


class FaceBox(BaseModel):
    #: Normalised to the source frame, 0..1, top-left origin.
    x: float
    y: float
    w: float
    h: float
    score: float
    #: Six BlazeFace keypoints (right eye, left eye, nose, mouth, right ear, left ear), 0..1.
    keypoints: list[tuple[float, float]]


class FaceFrame(BaseModel):
    t: float
    faces: list[FaceBox]


class FacesResponse(BaseModel):
    width: int
    height: int
    source_fps: float
    sample_fps: float
    frames_sampled: int
    frames_with_faces: int
    frames: list[FaceFrame]
    elapsed_s: float


# ---------------------------------------------------------------- frames/score


class FramesScoreRequest(BaseModel):
    #: Image files (JPEG/PNG...) to score; at most 64 per call.
    files: list[str] = Field(min_length=1, max_length=64)
    min_confidence: float = Field(default=0.4, ge=0, le=1)
    #: Also look for small faces in zoomed tiles (slower).
    small_faces: bool = False


class FrameScore(BaseModel):
    file: str
    width: int
    height: int
    #: Variance of the Laplacian of the 640 px-wide gray image (higher = sharper; ~20 blurry, 500+ crisp).
    sharpness: float
    #: Mean gray level, 0..1.
    brightness: float
    #: Standard deviation of the gray level, 0..1 (about 0.25 for a well exposed photo).
    contrast: float
    #: Faces, boxes normalised to the image, best first.
    faces: list[FaceBox]


class FramesScoreResponse(BaseModel):
    frames: list[FrameScore]
    elapsed_s: float
