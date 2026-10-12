"""Clip boundary rules: never start/end mid-sentence, fit lengths, trim fillers."""
from backend.app import boundaries, transcribe


def make_transcript(sentence_texts, wps=2.5, gap=0.4):
    words, t = [], 0.0
    for text in sentence_texts:
        for tok in text.split():
            words.append({"i": len(words), "w": tok, "s": round(t, 3), "e": round(t + 1 / wps - 0.05, 3)})
            t += 1 / wps
        t += gap
    return {"language": "en", "words": words, "sentences": transcribe.build_sentences(words)}


T = make_transcript([
    "So, um, I spent forty thousand dollars testing products.",
    "Thirty nine of them failed completely.",
    "The one that worked was a simple kitchen tool.",
    "It made back the whole budget in two weeks.",
    "And that is why I never stop testing.",
    "Anyway what were we talking about before?",
] * 3)


def test_sentences_split_on_punctuation():
    assert len(T["sentences"]) == 18
    assert T["sentences"][0]["text"].startswith("So, um,")
    assert T["sentences"][1]["text"] == "Thirty nine of them failed completely."


def test_snap_starts_and_ends_on_sentence_words():
    c = boundaries.snap(T, 0, 4, "value")
    words = T["words"]
    assert words[c["w1"]]["w"].endswith(".")                  # ends on a sentence end
    assert words[c["w0"]]["w"] == "I"                         # leading "So, um," trimmed
    assert c["start"] < words[c["w0"]]["s"] and c["end"] > words[c["w1"]]["e"]


def test_snap_grows_short_clip_by_whole_sentences():
    c = boundaries.snap(T, 1, 1, "hook")                     # one 2.4s sentence → grown to ≥ 12s
    assert c["duration"] >= 12 and c["start_sentence"] == 1


def test_snap_shrinks_from_start_keeping_payoff():
    c = boundaries.snap(T, 0, 17, "hook")
    assert c["end_sentence"] == 17 and c["duration"] <= 30 * 1.25


def test_dedupe_drops_near_duplicates():
    a = {"start": 0, "end": 30, "category": "value"}
    b = {"start": 2, "end": 31, "category": "value"}
    c = {"start": 40, "end": 70, "category": "value"}
    assert boundaries.dedupe([a, b, c]) == [a, c]


def test_long_runon_is_split():
    words = [{"i": i, "w": f"w{i}" + ("," if i % 20 == 19 else ""), "s": i * 0.3, "e": i * 0.3 + 0.25} for i in range(200)]
    sents = transcribe.build_sentences(words)
    assert all(s["w1"] - s["w0"] + 1 <= 70 for s in sents)
