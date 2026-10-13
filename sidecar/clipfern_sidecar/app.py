from __future__ import annotations

import logging
import os
import threading
from contextlib import asynccontextmanager
from importlib import metadata

from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse

from . import __version__, paths
from .auth import make_token_dependency
from .device import DeviceInfo, detect, machine_summary
from .faces import detect_faces
from .scenes import detect_scenes
from .schemas import (
    FacesRequest,
    FacesResponse,
    HealthResponse,
    ScenesRequest,
    ScenesResponse,
    TranscribeRequest,
    TranscribeResponse,
)
from .transcribe import transcribe
from .whisper_store import ModelNotDownloaded, WhisperStore

log = logging.getLogger("clipfern.sidecar")

_PACKAGES = {
    "faster_whisper": "faster-whisper",
    "ctranslate2": "ctranslate2",
    "mediapipe": "mediapipe",
    "scenedetect": "scenedetect",
    "opencv": "opencv-python",
    "numpy": "numpy",
    "huggingface_hub": "huggingface-hub",
    "fastapi": "fastapi",
}


def _versions() -> dict[str, str | None]:
    out: dict[str, str | None] = {}
    for key, dist in _PACKAGES.items():
        try:
            out[key] = metadata.version(dist)
        except metadata.PackageNotFoundError:
            out[key] = None
    return out


def create_app(token: str, device: DeviceInfo | None = None) -> FastAPI:
    device = device or detect()
    default_model = os.environ.get("CLIPFERN_WHISPER_MODEL", "large-v3-turbo")
    store = WhisperStore(device, default_model)

    def preload() -> None:
        # Warm the default model so the first /transcribe is not slowed by a cold load.
        try:
            if paths.whisper_model_ready(default_model):
                store.get(default_model)
        except Exception:  # noqa: BLE001
            log.exception("model preload failed")

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        threading.Thread(target=preload, name="model-preload", daemon=True).start()
        yield

    app = FastAPI(
        title="Clipfern sidecar",
        version=__version__,
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        dependencies=[Depends(make_token_dependency(token))],
    )

    @app.exception_handler(FileNotFoundError)
    async def _not_found(_: Request, exc: FileNotFoundError) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=404)

    @app.exception_handler(ModelNotDownloaded)
    async def _no_model(_: Request, exc: ModelNotDownloaded) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=409)

    @app.exception_handler(ValueError)
    async def _bad_value(_: Request, exc: ValueError) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=422)

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled error")
        return JSONResponse({"detail": f"{type(exc).__name__}: {exc}"}, status_code=500)

    @app.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        info = machine_summary()
        return HealthResponse(
            ok=True,
            version=__version__,
            python=info["python"],
            platform=info["platform"],
            device=device.device,
            whisper_device=device.whisper_device,
            compute_type=device.compute_type,
            device_note=device.note,
            default_model=default_model,
            model_loaded=default_model in store.loaded(),
            loaded_models=store.loaded(),
            model_downloaded=paths.whisper_model_ready(default_model),
            face_model_downloaded=paths.face_model_ready(),
            versions=_versions(),
        )

    # Plain `def` endpoints run in Starlette's thread pool, so long jobs never block /health.
    @app.post("/transcribe", response_model=TranscribeResponse)
    def post_transcribe(req: TranscribeRequest) -> TranscribeResponse:
        return transcribe(store, device, req)

    @app.post("/scenes", response_model=ScenesResponse)
    def post_scenes(req: ScenesRequest) -> ScenesResponse:
        return detect_scenes(req)

    @app.post("/faces", response_model=FacesResponse)
    def post_faces(req: FacesRequest) -> FacesResponse:
        return detect_faces(req)

    return app
