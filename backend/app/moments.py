"""Find Moments: natural-language search inside one video → scored, timestamped clips."""
from pydantic import BaseModel

from . import boundaries, llm, store
from .clipping import format_lines

SYSTEM = """You search inside a video transcript for moments matching a user's request, and return clips that
can be posted as standalone short-form videos.

Transcript lines look like `#<sentence id> [mm:ss.s] S<speaker>: <text>  {TAGS}`. TAGS are measured signals
(LOUD = louder than usual, REACTION = laugh or gasp, SCENE = picture changes), useful for requests like "funny moments".

Rules:
- Return only moments that genuinely match the request, best match first. Return an empty list if nothing matches.
- A clip is start_sentence..end_sentence inclusive. It must start where a cold viewer can follow, end on a complete
  thought or payoff, and usually last 15–90 seconds.
- match_score (0–100): how well the moment matches the request AND works as a standalone clip.
- quote: the single most relevant sentence, verbatim.
- why: one sentence on why it matches.
- Write in the transcript's language."""


class Moment(BaseModel):
    start_sentence: int
    end_sentence: int
    match_score: int
    title: str
    quote: str
    why: str


class MomentList(BaseModel):
    moments: list[Moment]


def find_moments(video_id: str, query: str, limit: int = 8) -> list[dict]:
    t = store.load(video_id, "transcript")
    c = store.load(video_id, "cues", {})
    # The full transcript is the cached context block: repeated searches on one video are cheap.
    context = f"Transcript (language: {t['language']}):\n" + format_lines(t, c)
    user = f"Request: {query}\nReturn at most {limit} moments."
    res = llm.call_json(MomentList, SYSTEM, user, context=context, video_id=video_id, tag="moments")
    out = []
    n = len(t["sentences"])
    for m in res.moments:
        if not (0 <= m.start_sentence < n and 0 <= m.end_sentence < n):
            continue
        snapped = boundaries.snap(t, m.start_sentence, m.end_sentence, min_len=8, max_len=120)
        if snapped:
            out.append({**m.model_dump(), **snapped, "match_score": max(0, min(100, m.match_score)),
                        "text": boundaries.text_of(t, snapped["w0"], snapped["w1"])})
    out.sort(key=lambda x: x["match_score"], reverse=True)
    return boundaries.dedupe([{**o, "category": "moment"} for o in out])
