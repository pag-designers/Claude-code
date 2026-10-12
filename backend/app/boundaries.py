"""Deterministic clip boundary rules. The AI picks sentence ids; this code turns them into exact, clean cut times."""
import re

LENGTH = {"hook": (15, 30), "value": (30, 60), "context": (60, 90)}
HARD_MIN, HARD_MAX = 8.0, 120.0
LEAD_PAD, TAIL_PAD = 0.10, 0.30   # seconds of air before the first word / after the last word

FILLERS = {
    "so", "um", "uh", "uhm", "erm", "like", "and", "but", "okay", "ok", "well", "yeah", "right", "anyway", "anyways",
    "y", "pero", "pues", "bueno", "entonces", "este", "eh", "o", "sea", "vale", "mm", "hmm", "oh",
}


def _norm(w: str) -> str:
    return re.sub(r"[^\w']", "", w.lower())


def word_range(sentences: list[dict], a: int, b: int) -> tuple[int, int]:
    return sentences[a]["w0"], sentences[b]["w1"]


def trim_leading_fillers(words: list[dict], w0: int, w1: int) -> int:
    """Skip filler words at the very start ("So, um, the thing is" → "the thing is"); keep ≥ 3 words."""
    k = w0
    while k < w1 - 2 and _norm(words[k]["w"]) in FILLERS:
        k += 1
    return k


def cut_times(words: list[dict], w0: int, w1: int) -> tuple[float, float]:
    """Start/end seconds with a little breathing room, never bleeding into the neighbouring words."""
    start = words[w0]["s"] - LEAD_PAD
    if w0 > 0:
        start = max(start, words[w0 - 1]["e"] + 0.02)
    end = words[w1]["e"] + TAIL_PAD
    if w1 + 1 < len(words):
        end = min(end, words[w1 + 1]["s"] - 0.02)
    return round(max(start, 0.0), 3), round(max(end, start + 0.1), 3)


def snap(transcript: dict, start_sentence: int, end_sentence: int, category: str | None = None,
         min_len: float | None = None, max_len: float | None = None) -> dict | None:
    """Clamp ids, grow/shrink by whole sentences to fit the length range, trim fillers, compute cut times.

    Returns None when no clean clip can be made (e.g. the moment is shorter than HARD_MIN even with neighbours).
    """
    sents, words = transcript["sentences"], transcript["words"]
    if not sents:
        return None
    n = len(sents)
    a = max(0, min(int(start_sentence), n - 1))
    b = max(a, min(int(end_sentence), n - 1))
    lo, hi = LENGTH.get(category or "", (HARD_MIN, HARD_MAX))
    lo = max(min_len if min_len is not None else lo * 0.8, HARD_MIN)
    hi = min(max_len if max_len is not None else hi * 1.25, HARD_MAX)
    dur = lambda: sents[b]["e"] - sents[a]["s"]
    # Too short: add the following sentence(s) first (keeps the chosen opening), then preceding ones.
    while dur() < lo and b + 1 < n and sents[b + 1]["e"] - sents[a]["s"] <= hi:
        b += 1
    while dur() < lo and a > 0 and sents[b]["e"] - sents[a - 1]["s"] <= hi:
        a -= 1
    # Too long: drop sentences from the start, never the payoff at the end.
    while dur() > hi and a < b:
        a += 1
    if dur() < HARD_MIN or dur() > HARD_MAX:
        return None
    w0, w1 = word_range(sents, a, b)
    w0 = trim_leading_fillers(words, w0, w1)
    start, end = cut_times(words, w0, w1)
    return {"start_sentence": a, "end_sentence": b, "w0": w0, "w1": w1, "start": start, "end": end,
            "duration": round(end - start, 2)}


def overlap(a: dict, b: dict) -> float:
    """Intersection over the shorter clip (0..1)."""
    inter = max(0.0, min(a["end"], b["end"]) - max(a["start"], b["start"]))
    return inter / max(min(a["end"] - a["start"], b["end"] - b["start"]), 1e-6)


def dedupe(clips: list[dict], threshold: float = 0.75) -> list[dict]:
    """Drop near-duplicates (chunks overlap, so the same moment can be proposed twice). Keeps the first seen."""
    kept: list[dict] = []
    for c in clips:
        if all(overlap(c, k) < threshold or c["category"] != k["category"] for k in kept):
            kept.append(c)
    return kept


def text_of(transcript: dict, w0: int, w1: int, removed: set[int] | None = None) -> str:
    removed = removed or set()
    return " ".join(w["w"] for w in transcript["words"][w0:w1 + 1] if w["i"] not in removed)


def norm_clip_id(raw: str) -> str:
    """'C01', 'Clip c01', 'c1' → 'c01' (models don't always echo ids exactly)."""
    m = re.search(r"c\s*0*(\d+)", raw.lower())
    return f"c{int(m.group(1)):02d}" if m else raw
