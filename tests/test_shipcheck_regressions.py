"""Regression tests for bugs found by the ship-check reviewers (so they can't silently come back)."""
import re
import subprocess
from pathlib import Path

from backend.app import boundaries, campaign, render, store, variants
from backend.app.config import DATA


def test_video_list_ignores_files_in_data(tmp_path):
    usage = DATA / "usage.jsonl"  # written by every real Claude call; used to break the home page
    existed = usage.exists()
    if not existed:
        usage.write_text('{"t": 0}\n')
    try:
        assert isinstance(store.list_videos(), list)
    finally:
        if not existed:
            usage.unlink()


def test_loading_unknown_video_creates_no_folder():
    assert store.load("no_such_video_xyz", "meta") is None
    assert not (DATA / "no_such_video_xyz").exists()


def test_clip_ids_are_normalised():
    assert [boundaries.norm_clip_id(x) for x in ["c01", "C01", "Clip c01", "c1", "clip C 7"]] == \
        ["c01", "c01", "c01", "c01", "c07"]


def test_required_caption_text_survives_x_length_limit():
    rules = {"required_hashtags": ["#netflixgames", "#ad"], "required_tags": ["@netflix"],
             "required_caption_text": ["Download Netflix Games free with your plan at netflix.com/games"]}
    post = variants._enforce({"caption": "x" * 400, "hashtags": ["#gaming"]}, "x", rules)
    full = f"{post['caption']} {' '.join(post['hashtags'])}"
    assert len(full) <= 280
    for need in ["@netflix", "netflix.com/games", "#netflixgames", "#ad"]:
        assert need in full


def test_variants_without_posts_borrow_variant_one():
    vs = [{"n": 1, "posts": {"tiktok": {"title": "t", "caption": "c", "hashtags": []}}}, {"n": 2, "posts": {}}]
    out = variants.apply_rules(vs, {"platforms": ["tiktok"], "required_hashtags": ["#ad"]})
    assert out[1]["posts"]["tiktok"]["hashtags"] == ["#ad"]


def test_language_names_match_codes():
    t = {"language": "en", "words": [{"i": 0, "w": "hi", "s": 0, "e": 1}], "sentences": []}
    rows = campaign.check_clip(t, {"w0": 0, "w1": 0, "start": 0, "end": 1}, {"language": "English"})
    assert rows[0]["status"] == "pass"


def test_windows_reserved_campaign_names():
    assert campaign.slug("Aux") == "aux-campaign" and campaign.slug("Acme") == "acme"


def test_filter_path_survives_odd_folder_names(tmp_path):
    odd = tmp_path / "O'Brien José, [x]; y"
    odd.mkdir()
    ass = odd / "t.ass"
    ass.write_text("[Script Info]\nPlayResX: 64\nPlayResY: 64\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize\n"
                   "Style: Default,Arial,20\n\n[Events]\nFormat: Layer, Start, End, Style, Text\n", encoding="utf-8")
    p = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=black:s=64x64:d=0.1",
                        "-vf", f"subtitles=filename={render._filter_path(ass)}", "-f", "null", "-"],
                       capture_output=True, text=True)
    assert p.returncode == 0, p.stderr


def test_speaker_keyframes_start_with_active_speaker():
    lay = {"layout": "speaker", "tracks": [{"cx": .2, "cy": .4, "w": .1, "h": .2}, {"cx": .8, "cy": .4, "w": .1, "h": .2}],
           "segments": [(0.0, 0), (5.0, 1), (9.0, 0)]}
    f = render.layout_filter(lay, 6.0, "r0", "v0", 1920, 1080, 1.0, dur=2.0)  # piece 6–8 s: speaker 1 only
    x = re.search(r"crop=\d+:\d+:'([^']*)'", f).group(1)
    assert "if(" not in x and int(x) > 1000  # one constant, on the right-hand speaker
