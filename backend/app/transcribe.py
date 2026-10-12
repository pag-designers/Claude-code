"""Speech → words with timestamps (faster-whisper) → sentences → approximate speaker labels."""
import re
import time
import wave
from pathlib import Path

import numpy as np

from . import store
from .config import MODELS, WHISPER_MODEL, WHISPER_THREADS, video_dir
from .ingest import extract_audio

SENTENCE_END = re.compile(r"[.!?…。？！]['\")\]]*$")
MAX_SENTENCE_WORDS = 45   # very long run-ons get split at a comma/pause so clips can still cut cleanly
PAUSE_SPLIT = 1.2         # a silence this long (s) ends a sentence even without punctuation

_model_cache: dict = {}


def _whisper(model_name: str):
    if model_name not in _model_cache:
        from faster_whisper import WhisperModel  # imported lazily: slow to import
        _model_cache[model_name] = WhisperModel(model_name, device="cpu", compute_type="int8",
                                                cpu_threads=WHISPER_THREADS, download_root=str(MODELS / "whisper"))
    return _model_cache[model_name]


def build_sentences(words: list[dict]) -> list[dict]:
    """Group words into sentences using punctuation, long pauses, and a max length."""
    sentences, cur = [], []

    def flush():
        if cur:
            sentences.append({"i": len(sentences), "s": cur[0]["s"], "e": cur[-1]["e"], "w0": cur[0]["i"],
                              "w1": cur[-1]["i"], "text": " ".join(w["w"] for w in cur).strip()})
            cur.clear()

    for k, w in enumerate(words):
        cur.append(w)
        nxt = words[k + 1] if k + 1 < len(words) else None
        gap = (nxt["s"] - w["e"]) if nxt else 0
        if SENTENCE_END.search(w["w"]) or gap >= PAUSE_SPLIT:
            flush()
        elif len(cur) >= MAX_SENTENCE_WORDS and (w["w"].endswith((",", ";", ":")) or gap > 0.35):
            flush()
        elif len(cur) >= MAX_SENTENCE_WORDS + 25:
            flush()
    flush()
    return sentences


def transcribe(video_id: str, model_name: str | None = None, on_progress=None) -> dict:
    """Cached: returns data/<id>/transcript.json if it already exists."""
    cached = store.load(video_id, "transcript")
    if cached:
        return cached
    wav = extract_audio(video_id)
    duration = store.load(video_id, "meta", {}).get("duration") or 1.0
    model_name = model_name or WHISPER_MODEL
    t0 = time.time()
    audio, _ = _read_wav(wav)  # pass samples directly (16 kHz mono float32), no extra decoder needed
    segments, info = _whisper(model_name).transcribe(
        audio, word_timestamps=True, vad_filter=True, beam_size=5,
        vad_parameters={"min_silence_duration_ms": 500}, condition_on_previous_text=False)
    words = []
    for seg in segments:  # a generator: transcription happens as we iterate
        for w in seg.words or []:
            text = w.word.strip()
            if text:
                words.append({"i": len(words), "w": text, "s": round(w.start, 3), "e": round(w.end, 3),
                              "p": round(w.probability, 3)})
        if on_progress:
            on_progress(min(seg.end / duration, 1.0))
    sentences = build_sentences(words)
    n_speakers = label_speakers(wav, sentences)
    result = {"language": info.language, "language_probability": round(info.language_probability, 3),
              "model": model_name, "seconds_taken": round(time.time() - t0, 1), "speakers": n_speakers,
              "words": words, "sentences": sentences}
    store.save(video_id, "transcript", result)
    return result


# ---------- approximate speaker labels (no account/token needed) ----------
# Voice "fingerprint" per sentence (MFCC mean+std), clustered with k-means; k picked by silhouette score.
# Good enough to separate clearly different voices; refined later by on-screen mouth movement when rendering.

def _read_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path)) as f:
        sr = f.getframerate()
        x = np.frombuffer(f.readframes(f.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    return x, sr


def _mfcc(x: np.ndarray, sr: int, n_mels: int = 26, n_ceps: int = 13) -> np.ndarray:
    win, hop, nfft = int(0.025 * sr), int(0.010 * sr), 512
    if len(x) < win:
        return np.zeros((0, n_ceps))
    n = 1 + (len(x) - win) // hop
    idx = np.arange(win)[None, :] + hop * np.arange(n)[:, None]
    frames = x[idx] * np.hamming(win)
    power = np.abs(np.fft.rfft(frames, nfft)) ** 2 / nfft
    mel = lambda f: 2595 * np.log10(1 + f / 700)
    imel = lambda m: 700 * (10 ** (m / 2595) - 1)
    pts = imel(np.linspace(mel(60), mel(sr / 2), n_mels + 2))
    bins = np.floor((nfft + 1) * pts / sr).astype(int)
    fb = np.zeros((n_mels, nfft // 2 + 1))
    for m in range(1, n_mels + 1):
        l, c, r = bins[m - 1], bins[m], bins[m + 1]
        fb[m - 1, l:c] = (np.arange(l, c) - l) / max(c - l, 1)
        fb[m - 1, c:r] = (r - np.arange(c, r)) / max(r - c, 1)
    logmel = np.log(power @ fb.T + 1e-10)
    k = np.arange(n_mels)
    dct = np.cos(np.pi / n_mels * (k[None, :] + 0.5) * np.arange(n_ceps)[:, None])
    return logmel @ dct.T


def _kmeans(X: np.ndarray, k: int, iters: int = 50, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    C = X[rng.choice(len(X), k, replace=False)]
    for _ in range(iters):
        lab = np.argmin(((X[:, None] - C[None]) ** 2).sum(-1), 1)
        newC = np.array([X[lab == j].mean(0) if (lab == j).any() else C[j] for j in range(k)])
        if np.allclose(newC, C):
            break
        C = newC
    return lab


def _silhouette(X: np.ndarray, lab: np.ndarray) -> float:
    D = np.sqrt(((X[:, None] - X[None]) ** 2).sum(-1))
    s = []
    for i in range(len(X)):
        same = lab == lab[i]
        if same.sum() < 2:
            s.append(0)
            continue
        a = D[i, same].sum() / (same.sum() - 1)
        b = min(D[i, lab == j].mean() for j in set(lab) if j != lab[i])
        s.append((b - a) / max(a, b))
    return float(np.mean(s))


def label_speakers(wav: Path, sentences: list[dict]) -> int:
    for s in sentences:
        s["spk"] = 1
    if len(sentences) < 6:
        return 1
    x, sr = _read_wav(wav)
    feats, idx = [], []
    for s in sentences:
        if s["e"] - s["s"] < 1.0:
            continue
        m = _mfcc(x[int(s["s"] * sr): int(s["e"] * sr)], sr)[:, 1:]
        if len(m) > 20:
            feats.append(np.concatenate([m.mean(0), m.std(0)]))
            idx.append(s["i"])
    if len(feats) < 6:
        return 1
    X = np.array(feats)
    X = (X - X.mean(0)) / (X.std(0) + 1e-8)
    if len(X) > 600:  # silhouette is O(n²): estimate k on a sample
        sample = np.random.default_rng(0).choice(len(X), 600, replace=False)
    else:
        sample = np.arange(len(X))
    best_k, best_s, best_lab = 1, 0.12, None  # require a minimum separation to claim >1 speaker
    for k in range(2, 5):
        if len(X) < k * 3:
            break
        lab = _kmeans(X, k)
        sil = _silhouette(X[sample], lab[sample])
        if sil > best_s:
            best_k, best_s, best_lab = k, sil, lab
    if best_lab is None:
        return 1
    # Number speakers by first appearance (S1 speaks first).
    order = {}
    for lab in best_lab:
        order.setdefault(int(lab), len(order) + 1)
    label_of = {i: order[int(l)] for i, l in zip(idx, best_lab)}
    prev = None
    for s in sentences:  # short sentences inherit the previous speaker
        s["spk"] = label_of.get(s["i"], prev or 1)
        prev = s["spk"]
    return best_k
