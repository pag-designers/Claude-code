"""Render a hand-picked moment in every layout/style (no AI needed). Usage: python scripts/render_test.py <video_id> <first_sentence> <last_sentence>"""
import sys, time
sys.path.insert(0, ".")
from backend.app import boundaries, render, store
from backend.app.config import video_dir

vid, a, b = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
t = store.load(vid, "transcript")
clip = {"id": "manual", **boundaries.snap(t, a, b, min_len=8, max_len=120)}
print("clip:", clip["start"], "→", clip["end"], f"({clip['duration']}s):", boundaries.text_of(t, clip["w0"], clip["w1"])[:160])
for name, plan in {
    "auto-boldpop": {"style": "bold-pop", "hook_text": "Netflix games are a trap?"},
    "track-karaoke": {"style": "karaoke", "layout": "track", "zoom": 1.1, "speed": 1.05},
    "speaker-boxed": {"style": "boxed", "layout": "speaker", "hook_text": "The word that changes everything"},
    "fit-clean": {"style": "clean", "layout": "fit", "brand_text": "@cordkillers"},
}.items():
    t0 = time.time()
    r = render.render(vid, clip, plan, video_dir(vid) / "renders" / f"test-{name}.mp4")
    print(f"  {name:15s} layout={r['layout']:8s} dur={r['duration']}s  rendered in {time.time()-t0:.0f}s")
