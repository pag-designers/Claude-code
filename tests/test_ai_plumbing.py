"""Clipping/scoring/moments plumbing with a fake LLM (checks chunking, id filtering, snapping, scoring math).
This does NOT test the quality of Claude's choices, only that our code handles its JSON correctly."""
import re
import shutil

import pytest

from backend.app import clipping, llm, moments, scoring, store
from backend.app.config import DATA
from tests.test_boundaries import make_transcript

VID = "test_fake_ai"


@pytest.fixture(autouse=True)
def fake_video():
    t = make_transcript([f"Sentence number {i} says something about topic {i // 10}." for i in range(400)])
    store.save(VID, "transcript", t)
    store.save(VID, "cues", {"peaks": [], "scenes": [], "reactions": []})
    store.save(VID, "meta", {"id": VID, "title": "Fake", "duration": t["sentences"][-1]["e"]})
    yield t
    llm.fake_call = None
    shutil.rmtree(DATA / VID, ignore_errors=True)


def fake(system, user, schema):
    ids = [int(x) for x in re.findall(r"^#(\d+) ", user, re.M)]
    if schema is clipping.CandidateList:
        a = ids[0]
        return schema(candidates=[
            clipping.Candidate(start_sentence=a + 2, end_sentence=a + 9, category="value", title="t", hook_text="h", why="w", payoff="p"),
            clipping.Candidate(start_sentence=a + 2, end_sentence=a + 9, category="value", title="dup", hook_text="h", why="w", payoff="p"),
            clipping.Candidate(start_sentence=a + 30, end_sentence=a + 33, category="hook", title="t2", hook_text="h", why="w", payoff="p"),
            clipping.Candidate(start_sentence=99999, end_sentence=99999, category="hook", title="bad id", hook_text="h", why="w", payoff="p"),
        ])
    if schema is scoring.ScoreList:
        clip_ids = re.findall(r"### Clip (\w+)", user)
        d = lambda s: scoring.Dim(score=s, reason="r", fix="f")
        return schema(scores=[scoring.ClipScore(clip_id=c, hook=d(80), story=d(70), value=d(60), engagement=d(50),
                                                reach=d(10), pacing=d(140), verdict="v") for c in clip_ids])
    if schema is moments.MomentList:
        return schema(moments=[moments.Moment(start_sentence=50, end_sentence=56, match_score=88, title="m", quote="q", why="w")])
    raise AssertionError(schema)


def test_clipping_chunks_and_filters():
    llm.fake_call = fake
    clips = clipping.find_candidates(VID)
    assert clips, "expected candidates"
    assert all(c["title"] != "bad id" for c in clips)                    # out-of-chunk ids rejected
    assert len({(c["start"], c["end"]) for c in clips}) == len(clips)     # duplicates removed
    assert len(clipping.chunks(store.load(VID, "transcript"))) > 1        # long transcript → several chunks


def test_scoring_math_and_clamping():
    llm.fake_call = fake
    clips = scoring.score_clips(VID, clipping.find_candidates(VID))
    c = clips[0]
    assert c["dims"]["pacing"]["score"] == 100                            # 140 clamped to 100
    assert c["score"] == 50                                               # reach 10 → ceiling at 50
    assert "wps" in c["pacing"]


def test_find_moments():
    llm.fake_call = fake
    res = moments.find_moments(VID, "topic 5")
    assert res and res[0]["match_score"] == 88 and res[0]["start"] < res[0]["end"]
