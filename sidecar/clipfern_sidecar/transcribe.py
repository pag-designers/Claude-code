from __future__ import annotations

import os
import time

from .device import DeviceInfo
from .schemas import Segment, TranscribeRequest, TranscribeResponse, Word
from .whisper_store import WhisperStore


def transcribe(store: WhisperStore, device: DeviceInfo, req: TranscribeRequest) -> TranscribeResponse:
    if not os.path.isfile(req.audio_path):
        raise FileNotFoundError(f"Audio file not found: {req.audio_path}")
    name, model = store.get(req.model)
    started = time.monotonic()
    with store.run_lock:
        segments_iter, info = model.transcribe(  # type: ignore[attr-defined]
            req.audio_path,
            language=req.language,
            beam_size=req.beam_size,
            vad_filter=req.vad_filter,
            vad_parameters={"min_silence_duration_ms": 500},
            word_timestamps=True,
            initial_prompt=req.initial_prompt,
            condition_on_previous_text=req.condition_on_previous_text,
        )
        segments: list[Segment] = []
        for seg in segments_iter:
            words = [
                Word(
                    word=w.word,
                    start=round(float(w.start), 3),
                    end=round(float(w.end), 3),
                    probability=round(float(w.probability), 4),
                )
                for w in (seg.words or [])
            ]
            segments.append(
                Segment(
                    id=int(seg.id),
                    start=round(float(seg.start), 3),
                    end=round(float(seg.end), 3),
                    text=seg.text,
                    avg_logprob=round(float(seg.avg_logprob), 4),
                    no_speech_prob=round(float(seg.no_speech_prob), 4),
                    words=words,
                )
            )
    return TranscribeResponse(
        model=name,
        device=device.whisper_device,
        compute_type=device.compute_type,
        language=info.language,
        language_probability=round(float(info.language_probability), 4),
        duration=round(float(info.duration), 3),
        duration_after_vad=round(float(info.duration_after_vad), 3),
        elapsed_s=round(time.monotonic() - started, 3),
        segments=segments,
    )
