"""Campaign checker: deterministic rules, auto-fixes, hashtag enforcement (no API calls)."""
from backend.app import boundaries, campaign, variants
from tests.test_boundaries import make_transcript

T = make_transcript([
    "Today we test the Acme blender against three others.",
    "Honestly the first one was a damn mess.",
    "The Acme one crushed ice in four seconds flat.",
    "That is twice as fast as anything else we tried.",
    "So if you make smoothies every day it pays for itself.",
    "Anyway let's move on to the next topic.",
] * 2)
RULES = {"campaign_name": "Acme", "slug": "acme", "min_seconds": 15, "max_seconds": 30, "language": "en",
         "platforms": ["tiktok", "x"], "must_mention": ["Acme", "BlendPro"], "required_hashtags": ["#acme", "#ad"],
         "required_tags": ["@acme"], "required_caption_text": ["code ACME10"], "banned_words": ["damn"],
         "banned_topics": [], "captions_required": True, "no_watermark": False, "vertical_required": True,
         "other_rules": [], "brief": "test"}


def clip_for(a, b):
    return {"id": "c01", **boundaries.snap(T, a, b, min_len=1, max_len=120)}


def statuses(rows):
    return {r["rule"]: r["status"] for r in rows}


def test_checks_and_fixes():
    c = clip_for(1, 2)                                     # too short, has "damn", no "BlendPro"
    before = statuses(campaign.check_clip(T, c, RULES))
    assert before["Length 15–30s"] == "fail" and before["Never says 'damn'"] == "fail"
    assert before["Mentions 'Acme'"] == "pass" and before["Mentions 'BlendPro'"] == "fail"
    fixed, notes = campaign.apply_fixes(T, c, RULES)
    after = statuses(campaign.check_clip(T, fixed, RULES))
    assert all(v == "pass" for v in after.values()), after
    assert fixed["brand_text"] == "BlendPro" and len(notes) == 3


def test_fold_matches_accents_and_case():
    assert campaign._contains("Me encanta ACMÉ!", "acme")
    assert not campaign._contains("acmefoods", "acme")     # whole words only


def test_hashtags_enforced_on_every_platform():
    vs = [{"n": 1, "posts": {"tiktok": {"title": "t", "caption": "great blender", "hashtags": ["#kitchen", "ad"]}}}]
    out = variants.apply_rules(vs, RULES)[0]["posts"]
    assert set(out) == {"tiktok", "x"}
    for post in out.values():
        text = post["caption"] + " " + " ".join(post["hashtags"])
        assert all(x.lower() in text.lower() for x in ["#acme", "#ad", "@acme", "code ACME10"])
    assert len(out["x"]["caption"] + " ".join(out["x"]["hashtags"])) <= 280
