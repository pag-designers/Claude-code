"""Phase 2 smoke test: import a file (or URL), transcribe, compute cues. Usage: python scripts/phase2_test.py <file-or-url>"""
import sys, time
sys.path.insert(0, ".")
from pathlib import Path
from backend.app import ingest, transcribe, cues

src = sys.argv[1]
t0 = time.time()
meta = ingest.download_url(src, ingest.video_id_for_url(src)) if src.startswith("http") else ingest.import_file(Path(src))
print("meta:", {k: meta[k] for k in ("id", "title", "duration", "width", "height", "fps")})
last = [0]
def prog(p):
    if p - last[0] >= 0.1: last[0] = p; print(f"  transcribing {p:.0%}  ({time.time()-t0:.0f}s)", flush=True)
t = transcribe.transcribe(meta["id"], on_progress=prog)
print(f"language={t['language']} ({t['language_probability']}) words={len(t['words'])} sentences={len(t['sentences'])} speakers={t['speakers']} took={t['seconds_taken']}s")
for s in t["sentences"][:8]:
    print(f"  [{s['s']:7.2f}-{s['e']:7.2f}] S{s['spk']}: {s['text']}")
c = cues.compute(meta["id"])
print(f"cues: {len(c['peaks'])} loud peaks, {len(c['scenes'])} scene changes, {len(c['reactions'])} reactions  total={time.time()-t0:.0f}s")
