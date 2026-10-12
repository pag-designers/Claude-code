"""Originality engine: 3 visibly different variants per moment + per-platform titles, captions and hashtags."""
import difflib
import re

from pydantic import BaseModel

from . import boundaries, llm, store
from .config import has_api_key

PLATFORM_LIMITS = {  # (title max, caption max incl. hashtags, max hashtags)
    "tiktok": (100, 2200, 5),
    "youtube_shorts": (100, 5000, 3),
    "instagram_reels": (100, 2200, 8),
    "x": (0, 280, 2),
}

# Deterministic differences between variants. The AI supplies the words; code guarantees the look differs.
PRESETS = [
    {"style": "bold-pop", "zoom": 1.00, "speed": 1.00, "layout": "auto", "cut": "standard", "hook_seconds": 2.5},
    {"style": "karaoke", "zoom": 1.08, "speed": 1.05, "layout": "speaker", "cut": "tight", "hook_seconds": 2.0},
    {"style": "boxed", "zoom": 1.15, "speed": 1.08, "layout": "track", "cut": "extended", "hook_seconds": 3.0},
]

SYSTEM = """You write the words for short-form clips that will be posted by many different clippers in a brand
campaign. Platforms down-rank duplicate-looking posts, so every variant must feel like a different post.

For the clip you get, write 3 variants. Each variant takes a different angle:
1. Curiosity gap: hint at the payoff without giving it away.
2. Bold claim or hot take, taken from what the speaker actually says.
3. Direct question or "you" framing that makes the viewer self-identify.

Per variant:
- hook_text: on-screen text for the first 2–3 seconds, at most 8 words, specific (no "You need to hear this").
- For each requested platform:
  - title: for YouTube Shorts (≤ 90 chars) and TikTok/Instagram (≤ 90 chars, punchy). Empty string for X.
  - caption: 1–2 sentences in the platform's native voice. TikTok: casual and conversational. Shorts: descriptive and
    searchable. Reels: relatable, with a light CTA ("save this", "send to a friend"). X: one tight line, ≤ 200 chars.
  - hashtags: 2–5 relevant, specific hashtags with '#' (no #fyp spam). Different mixes per variant.
- Never claim things the speaker didn't say. Write in the clip's language.
- Put required hashtags, tags and caption text exactly as given (code also enforces this)."""


class PlatformPost(BaseModel):
    platform: str
    title: str
    caption: str
    hashtags: list[str]


class Variant(BaseModel):
    angle: str
    hook_text: str
    posts: list[PlatformPost]


class Creative(BaseModel):
    variants: list[Variant]


def _enforce(post: dict, platform: str, rules: dict | None) -> dict:
    title_max, cap_max, tag_max = PLATFORM_LIMITS[platform]
    tags = []
    for h in post.get("hashtags", []):
        h = "#" + re.sub(r"[^\w]", "", h.lstrip("#"))
        if len(h) > 1 and h.lower() not in [t.lower() for t in tags]:
            tags.append(h)
    required = list((rules or {}).get("required_hashtags", []))
    tags = required + [t for t in tags if t.lower() not in [r.lower() for r in required]]
    tags = tags[:max(tag_max, len(required))]
    caption = post.get("caption", "").strip()
    for extra in (rules or {}).get("required_caption_text", []) + (rules or {}).get("required_tags", []):
        if extra.lower() not in caption.lower():
            caption = f"{caption} {extra}".strip()
    if platform == "youtube_shorts" and "#shorts" not in [t.lower() for t in tags]:
        tags.append("#Shorts")
    full = f"{caption} {' '.join(tags)}".strip()
    if len(full) > cap_max:  # trim the free text, never the required bits
        caption = caption[: max(0, cap_max - len(" ".join(tags)) - 2)].rstrip() + "…"
    title = post.get("title", "")[:title_max] if title_max else ""
    return {"title": title, "caption": caption, "hashtags": tags}


def _cut(transcript: dict, clip: dict, mode: str, rules: dict | None) -> dict:
    """standard = as picked; tight = start one sentence later; extended = one sentence earlier (if limits allow)."""
    lo = (rules or {}).get("min_seconds") or boundaries.HARD_MIN
    hi = (rules or {}).get("max_seconds") or boundaries.HARD_MAX
    a, b = clip["start_sentence"], clip["end_sentence"]
    if mode == "tight" and b - a >= 3:
        a += 1
    elif mode == "extended" and a > 0:
        a -= 1
    else:
        return {}
    snapped = boundaries.snap(transcript, a, b, min_len=lo, max_len=hi)
    if not snapped or snapped["end_sentence"] != b or not (lo <= snapped["duration"] <= hi):
        return {}
    return snapped


def similar(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, a.lower(), b.lower()).ratio()


def build_variants(video_id: str, clip: dict, rules: dict | None = None) -> list[dict]:
    """Returns 3 variant dicts: {n, plan (render settings), clip_patch (cut change), hook_text, posts{platform: post}}."""
    t = store.load(video_id, "transcript")
    platforms = (rules or {}).get("platforms") or list(PLATFORM_LIMITS)
    text = boundaries.text_of(t, clip["w0"], clip["w1"], set(clip.get("removed_words", [])))
    req = ""
    if rules:
        req = (f"\nRequired hashtags: {rules.get('required_hashtags')}\nRequired tags: {rules.get('required_tags')}\n"
               f"Required caption text: {rules.get('required_caption_text')}\nBrand: {rules.get('brand')}")
    user = (f"Language: {t['language']}\nPlatforms: {platforms}\nClip title: {clip.get('title', '')}\n"
            f"Clip transcript ({clip['end'] - clip['start']:.0f}s): {text}{req}")
    if has_api_key():
        creative = llm.call_json(Creative, SYSTEM, user, video_id=video_id, tag="variants", effort="low")
    else:  # no key: still render 3 distinct variants, with template captions the user should rewrite
        base = clip.get("title") or text[:60]
        creative = Creative(variants=[
            Variant(angle=a, hook_text=h, posts=[PlatformPost(platform=p, title=base if p != "x" else "", caption=base,
                                                              hashtags=[]) for p in platforms])
            for a, h in (("as picked", clip.get("hook_text") or base), ("title", base),
                         ("first line", " ".join(text.split()[:7])))])
    out = []
    hooks: list[str] = []
    for n, preset in enumerate(PRESETS):
        v = creative.variants[n] if n < len(creative.variants) else None
        hook = (v.hook_text if v else "") or clip.get("hook_text") or clip.get("title", "")
        if any(similar(hook, h) > 0.7 for h in hooks):  # difference check: no near-identical hooks
            hook = clip.get("title", hook) if all(similar(clip.get("title", ""), h) <= 0.7 for h in hooks) else hook
        hooks.append(hook)
        posts = {p.platform: _enforce(p.model_dump(), p.platform, rules) for p in (v.posts if v else [])
                 if p.platform in PLATFORM_LIMITS}
        out.append({"n": n + 1, "angle": v.angle if v else preset["cut"], "hook_text": hook,
                    "plan": {k: preset[k] for k in ("style", "zoom", "speed", "layout", "hook_seconds")} | {"hook_text": hook},
                    "clip_patch": _cut(t, clip, preset["cut"], rules), "posts": posts})
    return out


def apply_rules(vs: list[dict], rules: dict | None) -> list[dict]:
    """Re-enforce a campaign's required hashtags/tags/text and platforms on already-generated variants."""
    if not rules:
        return vs
    platforms = rules.get("platforms") or list(PLATFORM_LIMITS)
    out = []
    for v in vs:
        posts = {p: _enforce(post, p, rules) for p, post in v["posts"].items() if p in platforms}
        for p in platforms:  # platform the variant was not written for: reuse the first post's text
            if p not in posts and v["posts"]:
                first = next(iter(v["posts"].values()))
                posts[p] = _enforce({**first, "title": first.get("title", "")}, p, rules)
        out.append({**v, "posts": posts})
    return out


def caption_txt(clip: dict, variants: list[dict]) -> str:
    names = {"tiktok": "TikTok", "youtube_shorts": "YouTube Shorts", "instagram_reels": "Instagram Reels", "x": "X"}
    out = [f"{clip.get('title', clip['id'])}", "=" * 60, ""]
    for v in variants:
        file = "clip.mp4" if v["n"] == 1 else f"variant-{v['n']}.mp4"
        out += [f"## Variant {v['n']} ({file}): {v['angle']}", f"Hook: {v['hook_text']}", ""]
        for p, post in v["posts"].items():
            out.append(f"[{names.get(p, p)}]")
            if post["title"]:
                out.append(f"Title: {post['title']}")
            out.append(f"{post['caption']} {' '.join(post['hashtags'])}".strip())
            out.append("")
    return "\n".join(out)
