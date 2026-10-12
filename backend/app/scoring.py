"""Viral Score 0–100 with six dimensions. Rubric: prompts/scoring.md. Pacing numbers are measured in code."""
from concurrent.futures import ThreadPoolExecutor

from pydantic import BaseModel

from . import boundaries, llm, store

WEIGHTS = {"hook": 25, "story": 20, "value": 20, "engagement": 15, "reach": 10, "pacing": 10}
BATCH = 6


class Dim(BaseModel):
    score: int
    reason: str
    fix: str


class ClipScore(BaseModel):
    clip_id: str
    hook: Dim
    story: Dim
    value: Dim
    engagement: Dim
    reach: Dim
    pacing: Dim
    verdict: str


class ScoreList(BaseModel):
    scores: list[ClipScore]


def pacing_metrics(transcript: dict, clip: dict) -> dict:
    removed = set(clip.get("removed_words", []))
    words = [w for w in transcript["words"][clip["w0"]:clip["w1"] + 1] if w["i"] not in removed]
    if not words:
        return {"wps": 0, "max_pause": 0, "filler_ratio": 0, "words_first_3s": 0}
    dur = max(clip["end"] - clip["start"], 0.1)
    gaps = [b["s"] - a["e"] for a, b in zip(words, words[1:])]
    fillers = sum(1 for w in words if boundaries._norm(w["w"]) in {"um", "uh", "uhm", "erm", "eh", "mm", "hmm", "like"})
    return {"wps": round(len(words) / dur, 2), "max_pause": round(max(gaps, default=0), 2),
            "filler_ratio": round(fillers / len(words), 3),
            "words_first_3s": sum(1 for w in words if w["s"] < clip["start"] + 3)}


def overall(dims: dict) -> int:
    total = sum(dims[k]["score"] * w for k, w in WEIGHTS.items()) / sum(WEIGHTS.values())
    # Reach is a soft ceiling: a clip with very low reach can't be a top performer.
    total = min(total, dims["reach"]["score"] + 40)
    return int(round(max(0, min(100, total))))


def _clip_block(transcript: dict, clip: dict) -> str:
    m = clip.get("pacing") or pacing_metrics(transcript, clip)
    lines = []
    removed = set(clip.get("removed_words", []))
    for s in transcript["sentences"][clip["start_sentence"]:clip["end_sentence"] + 1]:
        words = [w for w in transcript["words"][max(s["w0"], clip["w0"]):min(s["w1"], clip["w1"]) + 1]
                 if w["i"] not in removed]
        if words:
            lines.append(f"[{words[0]['s'] - clip['start']:5.1f}s] S{s.get('spk', 1)}: " + " ".join(w["w"] for w in words))
    return (f"### Clip {clip['id']} ({clip['category']}, {clip['end'] - clip['start']:.1f}s)\n"
            f"Planned hook text overlay: {clip.get('hook_text', '')}\n"
            f"Pacing: {m['wps']} words/s, longest pause {m['max_pause']}s, filler ratio {m['filler_ratio']}, "
            f"{m['words_first_3s']} words in first 3s\n" + "\n".join(lines))


def score_clips(video_id: str, clips: list[dict]) -> list[dict]:
    """Adds 'score', 'dims', 'verdict', 'pacing' to each clip (in place) and returns them sorted by score."""
    t = store.load(video_id, "transcript")
    system = llm.prompt("scoring.md")
    for c in clips:
        c["pacing"] = pacing_metrics(t, c)
    batches = [clips[i:i + BATCH] for i in range(0, len(clips), BATCH)]

    def ask(batch: list[dict]) -> list[ClipScore]:
        user = (f"Transcript language: {t['language']}. Score these {len(batch)} clips. "
                f"Return exactly one score object per clip_id.\n\n" + "\n\n".join(_clip_block(t, c) for c in batch))
        return llm.call_json(ScoreList, system, user, video_id=video_id, tag="scoring").scores

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = {s.clip_id: s for batch in pool.map(ask, batches) for s in batch}
    for c in clips:
        s = results.get(c["id"])
        if not s:
            continue
        dims = {k: {**getattr(s, k).model_dump(), "score": max(0, min(100, getattr(s, k).score))} for k in WEIGHTS}
        c.update(dims=dims, score=overall(dims), verdict=s.verdict)
    return sorted(clips, key=lambda x: x.get("score", -1), reverse=True)
