"""Campaign Requirements Checker: brief → typed rules (Claude) → per-clip pass/fail (code first, AI for fuzzy rules) → auto-fixes."""
import re
import unicodedata
from typing import Literal

from pydantic import BaseModel

from . import boundaries, llm, store, timeline
from .config import CAMPAIGNS

PLATFORMS = ["tiktok", "youtube_shorts", "instagram_reels", "x"]


class Rules(BaseModel):
    campaign_name: str
    brand: str | None
    min_seconds: float | None
    max_seconds: float | None
    language: str | None                 # ISO 639-1 code, e.g. "en", "es"
    platforms: list[Literal["tiktok", "youtube_shorts", "instagram_reels", "x"]]
    must_mention: list[str]              # names/phrases that must be said or shown in the video
    required_hashtags: list[str]
    required_tags: list[str]             # @accounts to tag in the post
    required_caption_text: list[str]     # e.g. "link in bio", a promo code
    banned_words: list[str]
    banned_topics: list[str]
    captions_required: bool
    no_watermark: bool                   # no third-party/personal watermarks
    vertical_required: bool
    other_rules: list[str]               # anything else, checked by AI


PARSE_SYSTEM = """You turn a brand's clipping-campaign brief (from Whop Content Rewards or similar) into strict rules.
Brands may reject a clip ONLY for breaking a written requirement, so capture every requirement, and never invent ones
that aren't written.

- min_seconds/max_seconds: clip length limits in seconds (e.g. "30-60s" → 30 and 60; "under 1 minute" → null, 59).
- language: ISO 639-1 code if a spoken/caption language is required, else null.
- platforms: where posts are allowed. If not stated, list all four.
- must_mention: brand or product names that must be spoken or shown in the video itself.
- required_hashtags: include the leading '#'. required_tags: include the leading '@'.
- required_caption_text: exact text that must appear in the post caption (promo codes, "link in bio", URLs).
- banned_words: specific words that must not be said. banned_topics: topics or content types that are not allowed
  (e.g. "politics", "competitor products", "profanity", "reuploading full episodes").
- captions_required: true if subtitles/captions must be on the video. no_watermark: true if watermarks/logos from
  other tools or accounts are banned. vertical_required: true if 9:16/vertical is required.
- other_rules: every remaining requirement, one short sentence each (e.g. "Must use the official sound",
  "Account must have 1,000+ followers", "Post must stay up for 30 days").
- campaign_name: a short name (from the brief, or brand + topic)."""


def slug(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:60] or "campaign"


def parse_brief(brief: str, name: str | None = None) -> dict:
    rules = llm.call_json(Rules, PARSE_SYSTEM, f"Campaign brief:\n\"\"\"\n{brief}\n\"\"\"", tag="campaign_parse",
                          effort="low", max_tokens=8000)
    data = rules.model_dump()
    data["platforms"] = data["platforms"] or PLATFORMS
    data["campaign_name"] = name or data["campaign_name"]
    data["slug"] = slug(data["campaign_name"])
    data["brief"] = brief
    for k, prefix in (("required_hashtags", "#"), ("required_tags", "@")):
        data[k] = [x if x.startswith(prefix) else prefix + x.lstrip("#@") for x in data[k]]
    store.write_json(CAMPAIGNS / f"{data['slug']}.json", data)
    return data


def load_campaign(slug_: str) -> dict | None:
    return store.read_json(CAMPAIGNS / f"{slug_}.json")


def list_campaigns() -> list[dict]:
    return [store.read_json(p) for p in sorted(CAMPAIGNS.glob("*.json"))]


def _fold(s: str) -> str:
    """Lowercase, strip accents and punctuation: 'Wayfair®' ~ 'wayfair'."""
    s = unicodedata.normalize("NFKD", s.lower()).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9@# ]+", " ", s)


def _contains(text: str, phrase: str) -> bool:
    return re.search(rf"(?<![a-z0-9]){re.escape(_fold(phrase).strip())}(?![a-z0-9])", _fold(text)) is not None


# ---------- auto-fixes (applied before rendering) ----------

def apply_fixes(transcript: dict, clip: dict, rules: dict) -> tuple[dict, list[str]]:
    """Return a fixed copy of the clip plus a list of what was changed."""
    c = dict(clip)
    notes = []
    banned = [b for b in rules.get("banned_words", []) if b.strip()]
    if banned:  # first, so the length fix below accounts for the removed audio
        hits = [w["i"] for w in transcript["words"][c["w0"]:c["w1"] + 1] if any(_contains(w["w"], b) for b in banned)]
        if hits:
            c["removed_words"] = sorted(set(c.get("removed_words", [])) | set(hits))
            notes.append(f"Banned words: cut {len(hits)} word(s) from the audio")
    lo, hi = rules.get("min_seconds"), rules.get("max_seconds")
    edited = timeline.build(c, transcript["words"]).duration      # length after text edits
    if (lo and edited < lo) or (hi and edited > hi):
        deficit = (c["end"] - c["start"]) - edited                 # seconds removed by edits
        snapped = boundaries.snap(transcript, c["start_sentence"], c["end_sentence"],
                                  min_len=(lo + deficit + 0.3) if lo else boundaries.HARD_MIN,
                                  max_len=(hi + deficit - 0.5) if hi else boundaries.HARD_MAX)
        if snapped:
            trial = {**c, **snapped}
            trial["removed_words"] = [w for w in c.get("removed_words", []) if snapped["w0"] <= w <= snapped["w1"]]
            if banned:  # sentences added by the re-cut may contain banned words too
                trial["removed_words"] = sorted(set(trial["removed_words"]) | {
                    w["i"] for w in transcript["words"][snapped["w0"]:snapped["w1"] + 1] if any(_contains(w["w"], b) for b in banned)})
            new_len = timeline.build(trial, transcript["words"]).duration
            if (not lo or new_len >= lo) and (not hi or new_len <= hi):
                c = trial
                edited = new_len
                notes.append(f"Length: re-cut to {new_len:.1f}s on sentence boundaries")
        if hi and edited > hi and edited / hi <= 1.12:
            c["speed"] = round(min(1.12, edited / (hi - 0.5)), 3)
            notes.append(f"Length: sped up to {c['speed']}x to fit {hi:.0f}s")
    spoken = boundaries.text_of(transcript, c["w0"], c["w1"], set(c.get("removed_words", [])))
    missing = [m for m in rules.get("must_mention", []) if not _contains(spoken, m)]
    if missing and not c.get("brand_text"):
        c["brand_text"] = " · ".join(missing)
        notes.append(f"Brand mention: added on-screen text '{c['brand_text']}'")
    return c, notes


# ---------- checks ----------

class AIRuleResult(BaseModel):
    rule: str
    status: Literal["pass", "fail", "unsure"]
    reason: str


class AIClipCheck(BaseModel):
    clip_id: str
    results: list[AIRuleResult]


class AICheckList(BaseModel):
    clips: list[AIClipCheck]


AI_CHECK_SYSTEM = """You check short video clips against a brand campaign's written rules. For each clip and each rule,
answer pass, fail, or unsure from the clip transcript and the post captions. Be strict but fair: only fail a clip when
the transcript or captions clearly break the rule. Use 'unsure' when the rule can't be judged from text (e.g. it
depends on the poster's account, or on visuals). Give a one-sentence reason."""


def _row(rule: str, status: str, detail: str, by: str = "code") -> dict:
    return {"rule": rule, "status": status, "detail": detail, "by": by}


def check_clip(transcript: dict, clip: dict, rules: dict, render_info: dict | None = None,
               metadata: dict | None = None) -> list[dict]:
    """Deterministic checks. `render_info` = what will be/was rendered (duration, style), `metadata` = platform captions."""
    rows = []
    removed = set(clip.get("removed_words", []))
    spoken = boundaries.text_of(transcript, clip["w0"], clip["w1"], removed)
    dur = (render_info or {}).get("duration") or timeline.build(clip, transcript["words"], float(clip.get("speed", 1.0))).duration
    lo, hi = rules.get("min_seconds"), rules.get("max_seconds")
    if lo or hi:
        ok = (not lo or dur >= lo) and (not hi or dur <= hi)
        rows.append(_row(f"Length {lo or 0:.0f}–{hi or '∞'}s", "pass" if ok else "fail", f"{dur:.1f}s"))
    if rules.get("language"):
        lang = transcript.get("language")
        rows.append(_row(f"Language: {rules['language']}", "pass" if lang == rules["language"] else "fail",
                         f"spoken language detected: {lang}"))
    for m in rules.get("must_mention", []):
        if _contains(spoken, m):
            rows.append(_row(f"Mentions '{m}'", "pass", "said in the clip"))
        elif m.lower() in (clip.get("brand_text") or "").lower() or m.lower() in (clip.get("hook_text") or "").lower():
            rows.append(_row(f"Mentions '{m}'", "pass", "shown as on-screen text"))
        else:
            rows.append(_row(f"Mentions '{m}'", "fail", "not said or shown; auto-fix adds on-screen text"))
    for b in rules.get("banned_words", []):
        hit = _contains(spoken, b)
        rows.append(_row(f"Never says '{b}'", "fail" if hit else "pass", "found in audio" if hit else "not found"))
    style = (render_info or {}).get("style") or clip.get("style") or "bold-pop"
    if rules.get("captions_required"):
        rows.append(_row("Burned-in captions", "pass" if style != "none" else "fail", f"style: {style}"))
    if rules.get("vertical_required"):
        rows.append(_row("Vertical 9:16", "pass", "rendered at 1080×1920"))
    if rules.get("no_watermark"):
        rows.append(_row("No third-party watermark", "pass", "Clipper adds no watermark; check the source video itself"))
    if metadata:
        for p in rules.get("platforms") or PLATFORMS:
            post = metadata.get(p)
            if not post:
                continue
            text = " ".join([post.get("title", ""), post.get("caption", ""), " ".join(post.get("hashtags", []))])
            need = rules.get("required_hashtags", []) + rules.get("required_tags", []) + rules.get("required_caption_text", [])
            missing = [n for n in need if n.lower() not in text.lower()]
            if need:
                rows.append(_row(f"{p}: required hashtags/tags/text", "fail" if missing else "pass",
                                 ("missing " + ", ".join(missing)) if missing else "all present"))
    return rows


def ai_checks(video_id: str, transcript: dict, clips: list[dict], rules: dict) -> dict[str, list[dict]]:
    fuzzy = [f"Must avoid topic: {t}" for t in rules.get("banned_topics", [])] + list(rules.get("other_rules", []))
    if not fuzzy or not clips:
        return {}
    blocks = []
    for c in clips:
        text = boundaries.text_of(transcript, c["w0"], c["w1"], set(c.get("removed_words", [])))
        blocks.append(f"### Clip {c['id']}\nTranscript: {text}\nOn-screen hook: {c.get('hook_text') or '-'}")
    user = "Rules:\n" + "\n".join(f"- {r}" for r in fuzzy) + "\n\n" + "\n\n".join(blocks)
    res = llm.call_json(AICheckList, AI_CHECK_SYSTEM, user, video_id=video_id, tag="campaign_check", effort="low")
    return {c.clip_id: [_row(r.rule, r.status if r.status != "unsure" else "warn", r.reason, "ai") for r in c.results]
            for c in res.clips}


def summarize(rows: list[dict]) -> str:
    if any(r["status"] == "fail" for r in rows):
        return "fail"
    return "warn" if any(r["status"] == "warn" for r in rows) else "pass"


def checklist_md(clip: dict, rules: dict, rows: list[dict], fixes: list[str]) -> str:
    icon = {"pass": "✅", "fail": "❌", "warn": "⚠️"}
    out = [f"# Requirements checklist: {clip.get('title', clip['id'])}", "",
           f"Campaign: **{rules.get('campaign_name')}**  ", f"Overall: {icon[summarize(rows)]} {summarize(rows).upper()}", "",
           "| | Rule | Detail | Checked by |", "|---|---|---|---|"]
    out += [f"| {icon[r['status']]} | {r['rule']} | {r['detail']} | {r['by']} |" for r in rows]
    if fixes:
        out += ["", "## Auto-fixes applied", *[f"- {f}" for f in fixes]]
    out += ["", "## Brief (as pasted)", "", "> " + rules.get("brief", "").replace("\n", "\n> ")]
    return "\n".join(out) + "\n"
