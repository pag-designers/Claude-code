"""Lazy, thread-safe cache of loaded faster-whisper models."""

from __future__ import annotations

import threading

from . import paths
from .device import DeviceInfo


class ModelNotDownloaded(RuntimeError):
    pass


class WhisperStore:
    def __init__(self, device: DeviceInfo, default_model: str) -> None:
        self.device = device
        self.default_model = default_model
        self._models: dict[str, object] = {}
        self._load_lock = threading.Lock()
        #: CTranslate2 handles concurrent calls, but one at a time keeps RAM/VRAM predictable.
        self.run_lock = threading.Lock()

    def loaded(self) -> list[str]:
        return sorted(self._models)

    def get(self, name: str | None = None):
        name = name or self.default_model
        model = self._models.get(name)
        if model is not None:
            return name, model
        with self._load_lock:
            model = self._models.get(name)
            if model is None:
                if not paths.whisper_model_ready(name):
                    raise ModelNotDownloaded(
                        f"Whisper model '{name}' is not downloaded. "
                        "Run bootstrap/download_model.py first."
                    )
                from faster_whisper import WhisperModel

                model = WhisperModel(
                    str(paths.whisper_model_dir(name)),
                    device=self.device.whisper_device,
                    compute_type=self.device.compute_type,
                )
                self._models[name] = model
        return name, model
