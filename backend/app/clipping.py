"""AI Clipping: find 10–20 candidate moments from the transcript (fed to Claude in timestamped chunks)."""
import math
from concurrent.futures import ThreadPoolExecutor
from typing import Literal

from pydantic import BaseModel

from . import boundaries, cues as cues_mod, llm, store

CHUNK_SECONDS = 420     # ~7 min of transcript per request
CHUNK_OVERLAP = 60      # overlap so a moment on a chunk border is seen whole at least once


class Candidate(BaseModel):
    start_sentence: int
    end_sentence: int
    category: Literal["hook", "value", "context"]
    title: str
    hook_text: str
    why: str
    payoff: str


class CandidateList(BaseModel):
    candidates: list[Candidate]


def mmss(t: float) -> str:
    return f"{int(t // 60):02d}:{t % 60:04.1f}"


def format_lines(transcript: dict, cues: dict | None, a: int = 0, b: int | None = None) -> str:
    sents = transcript["sentences"]
    b = len(sents) - 1 if b is None else b
    out = []
    for s in sents[a:b + 1]:
        tags = cues_mod.sentence_tags(s, cues) if cues else []
        out.append(f"#{s['i']} [{mmss(s['s'])}] S{s.get('spk', 1)}: {s['text']}" + (f"  {{{','.join(tags)}}}" if tags else ""))
    return "\n".join(out)


def chunks(transcript: dict) -> list[tuple[int, int]]:
    """Sentence-index ranges of ~CHUNK_SECONDS with CHUNK_OVERLAP overlap."""
    sents = transcript["sentences"]
    if not sents:
        return []
    out, a = [], 0
    while a < len(sents):
        t_end = sents[a]["s"] + CHUNK_SECONDS
        b = a
        while b + 1 < len(sents) and sents[b + 1]["e"] <= t_end:
            b += 1
        out.append((a, b))
        if b >= len(sents) - 1:
            break
        nxt = b
        while nxt > a and sents[nxt]["s"] > sents[b]["e"] - CHUNK_OVERLAP:
            nxt -= 1
        a = max(nxt, a + 1)
    return out


def find_candidates(video_id: str, target: int | None = None) -> list[dict]:
    """Returns snapped, de-duplicated clip dicts (unscored). Saved to clips.json by the pipeline."""
    t = store.load(video_id, "transcript")
    c = store.load(video_id, "cues", {})
    meta = store.load(video_id, "meta", {})
    duration = meta.get("duration") or (t["sentences"][-1]["e"] if t["sentences"] else 0)
    target = target or max(10, min(20, round(duration / 60 * 1.2)))
    parts = chunks(t)
    per_chunk = max(3, math.ceil(target * 1.4 / max(len(parts), 1)))
    system = llm.prompt("clipping.md")
    title = meta.get("title", "")

    def ask(part: tuple[int, int]) -> list[Candidate]:
        a, b = part
        user = (f"Video title: {title}\nTranscript language: {t['language']}\n"
                f"This section is sentences #{a}–#{b} ({mmss(t['sentences'][a]['s'])}–{mmss(t['sentences'][b]['e'])}).\n"
                f"Return up to {per_chunk} candidates, using only sentence ids from this section.\n\n"
                + format_lines(t, c, a, b))
        res = llm.call_json(CandidateList, system, user, video_id=video_id, tag="clipping")
        return [x for x in res.candidates if a <= x.start_sentence <= b and x.end_sentence <= b + 3]

    with ThreadPoolExecutor(max_workers=4) as pool:
        proposals = [cand for chunk in pool.map(ask, parts) for cand in chunk]

    clips = []
    for p in proposals:
        snapped = boundaries.snap(t, p.start_sentence, p.end_sentence, p.category)
        if not snapped:
            continue
        clips.append({**p.model_dump(), **snapped,
                      "text": boundaries.text_of(t, snapped["w0"], snapped["w1"])})
    clips.sort(key=lambda x: x["start"])
    clips = boundaries.dedupe(clips)
    for i, clip in enumerate(clips):
        clip["id"] = f"c{i + 1:02d}"
    return clips
