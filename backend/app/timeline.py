"""Edit timeline: which source ranges survive text edits, and how source time maps to output time."""
from dataclasses import dataclass

MERGE_GAP = 0.15  # ranges closer than this are merged (avoids micro-cuts)


@dataclass
class Timeline:
    ranges: list[tuple[float, float]]  # source seconds, in order
    speed: float = 1.0

    @property
    def duration(self) -> float:
        return sum(e - s for s, e in self.ranges) / self.speed

    def to_output(self, t: float) -> float | None:
        """Source time → output time (None if t falls in a removed part)."""
        acc = 0.0
        for s, e in self.ranges:
            if s - 1e-3 <= t <= e + 1e-3:
                return (acc + min(max(t - s, 0.0), e - s)) / self.speed
            acc += e - s
        return None

    def to_concat(self, t: float) -> float | None:
        """Source time → time in the joined (pre-speed) stream; used for crop keyframes."""
        out = self.to_output(t)
        return None if out is None else out * self.speed


def build(clip: dict, words: list[dict], speed: float = 1.0) -> Timeline:
    """Keep ranges from the clip's words minus `removed_words` (text-based editing)."""
    removed = set(clip.get("removed_words", []))
    kept = [w for w in words[clip["w0"]:clip["w1"] + 1] if w["i"] not in removed]
    if not kept:
        raise ValueError("Every word of this clip was deleted.")
    groups: list[list[dict]] = [[kept[0]]]
    for prev, w in zip(kept, kept[1:]):
        if w["i"] == prev["i"] + 1:
            groups[-1].append(w)
        else:
            groups.append([w])
    ranges = []
    for gi, g in enumerate(groups):
        s = clip["start"] if gi == 0 else g[0]["s"] - 0.06
        e = clip["end"] if gi == len(groups) - 1 else g[-1]["e"] + 0.06
        # never include audio of an adjacent removed word
        if gi > 0:
            s = max(s, words[g[0]["i"] - 1]["e"] + 0.01)
        if gi < len(groups) - 1:
            e = min(e, words[g[-1]["i"] + 1]["s"] - 0.01)
        if ranges and s - ranges[-1][1] < MERGE_GAP:
            ranges[-1] = (ranges[-1][0], e)
        else:
            ranges.append((round(s, 3), round(e, 3)))
    return Timeline(ranges=ranges, speed=speed)


def output_words(clip: dict, words: list[dict], tl: Timeline) -> list[dict]:
    """Kept words with output-timeline start/end, for captions."""
    removed = set(clip.get("removed_words", []))
    out = []
    for w in words[clip["w0"]:clip["w1"] + 1]:
        if w["i"] in removed:
            continue
        s, e = tl.to_output(w["s"]), tl.to_output(w["e"])
        if s is not None and e is not None:
            out.append({**w, "os": round(s, 3), "oe": round(max(e, s + 0.05), 3)})
    return out
