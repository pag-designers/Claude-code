"""Background jobs: ingest → transcribe → cues → AI clipping → scoring, plus preview renders and exports."""
import hashlib
import json
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import campaign, clipping, cues, export, ingest, llm, render, scoring, store, transcribe
from .config import has_api_key, video_dir

_heavy = ThreadPoolExecutor(max_workers=1, thread_name_prefix="pipeline")   # CPU-heavy: one at a time
_render = ThreadPoolExecutor(max_workers=2, thread_name_prefix="render")
JOBS: dict[str, dict] = {}
_lock = threading.Lock()


def _job(kind: str, video_id: str | None, fn, pool=_heavy, **meta) -> dict:
    job = {"id": uuid.uuid4().hex[:10], "kind": kind, "video_id": video_id, "status": "queued", "progress": 0.0,
           "message": "", "result": None, "error": None, "created": time.time(), **meta}
    with _lock:
        JOBS[job["id"]] = job

    def progress(p: float, msg: str = ""):
        job["progress"] = round(max(0.0, min(1.0, p)), 3)
        if msg:
            job["message"] = msg

    def run():
        job["status"] = "running"
        try:
            job["result"] = fn(progress)
            job["status"], job["progress"] = "done", 1.0
        except Exception as e:  # surface every failure to the UI with a readable message
            job["status"], job["error"] = "error", str(e)
            traceback.print_exc()
    pool.submit(run)
    return job


# ---------- the main pipeline ----------

def _process(video_id: str, progress, url: str | None = None) -> dict:
    def stage(name: str, a: float, b: float, msg: str):
        store.set_status(video_id, name, a, msg)
        progress(a, msg)
        return lambda p: (store.set_status(video_id, name, a + (b - a) * p, msg), progress(a + (b - a) * p))

    try:
        if url:
            ingest.download_url(url, video_id, stage("download", 0.0, 0.15, "Downloading video"))
        stage("audio", 0.15, 0.18, "Extracting audio")
        ingest.extract_audio(video_id)
        transcribe.transcribe(video_id, on_progress=stage("transcribe", 0.18, 0.70, "Transcribing (word timestamps)"))
        stage("cues", 0.70, 0.75, "Finding loud moments and scene changes")
        cues.compute(video_id)
        if not has_api_key():
            store.set_status(video_id, "needs_key", 0.75, "Transcript ready. Add ANTHROPIC_API_KEY to run AI clipping.")
            return {"video_id": video_id, "clips": 0}
        stage("clipping", 0.75, 0.88, "AI is finding the best moments")
        found = clipping.find_candidates(video_id)
        stage("scoring", 0.88, 0.99, f"Scoring {len(found)} clips")
        ranked = scoring.score_clips(video_id, found)
        store.save(video_id, "clips", ranked)
        store.set_status(video_id, "ready", 1.0, f"{len(ranked)} clips ready")
        return {"video_id": video_id, "clips": len(ranked)}
    except Exception as e:
        store.set_status(video_id, "error", 0, "Failed", error=str(e))
        raise


def start_url(url: str) -> dict:
    video_id = ingest.video_id_for_url(url)
    if not store.load(video_id, "meta"):
        store.save(video_id, "meta", {"id": video_id, "source_url": url, "title": url, "duration": None})
    store.set_status(video_id, "queued", 0, "Queued")
    return _job("process", video_id, lambda p: _process(video_id, p, url=url))


def start_file(path: Path, title: str | None = None) -> dict:
    meta = ingest.import_file(path, title=title, move=True)
    store.set_status(meta["id"], "queued", 0, "Queued")
    return _job("process", meta["id"], lambda p: _process(meta["id"], p))


def rerun_clipping(video_id: str) -> dict:
    def fn(progress):
        store.save(video_id, "clips", [])
        return _process(video_id, progress)
    return _job("process", video_id, fn)


# ---------- previews & exports ----------

def preview(video_id: str, clip: dict, plan: dict) -> dict:
    """Low-res quick render (540x960). Same settings → same file, so repeated previews are instant."""
    key = hashlib.sha1(json.dumps([clip.get("start"), clip.get("end"), clip.get("removed_words", []), plan],
                                  sort_keys=True, default=str).encode()).hexdigest()[:10]
    out = video_dir(video_id) / "renders" / f"{clip['id']}-preview-{key}.mp4"

    def fn(progress):
        if not out.exists():
            render.render(video_id, clip, plan, out, preview=True)
        return {"url": f"/media/{video_id}/renders/{out.name}"}
    return _job("preview", video_id, fn, pool=_render, clip_id=clip["id"])


def export_many(video_id: str, clip_ids: list[str], campaign_slug: str | None, n_variants: int = 3) -> dict:
    def fn(progress):
        results = []
        for i, cid in enumerate(clip_ids):
            progress(i / len(clip_ids), f"Exporting {cid} ({i + 1}/{len(clip_ids)})")
            results.append(export.export_clip(video_id, cid, campaign_slug, n_variants,
                                              on_progress=lambda p, i=i: progress((i + p) / len(clip_ids))))
        return {"exports": results}
    return _job("export", video_id, fn, pool=_render)


def check_campaign(video_id: str, campaign_slug: str) -> dict:
    """Per-clip compliance (code checks + AI checks for fuzzy rules). Stored on each clip as checks[slug]."""
    def fn(progress):
        rules = campaign.load_campaign(campaign_slug)
        if not rules:
            raise ValueError("Unknown campaign")
        t = store.load(video_id, "transcript")
        clips = store.load(video_id, "clips", [])
        ai = campaign.ai_checks(video_id, t, clips, rules) if has_api_key() else {}
        for c in clips:
            fixed, fixes = campaign.apply_fixes(t, c, rules)
            rows_now = campaign.check_clip(t, c, rules)
            rows_fixed = campaign.check_clip(t, fixed, rules)
            c.setdefault("checks", {})[campaign_slug] = {
                "rows": rows_now + ai.get(c["id"], []), "status": campaign.summarize(rows_now + ai.get(c["id"], [])),
                "after_fixes": campaign.summarize(rows_fixed + ai.get(c["id"], [])), "fixes": fixes}
        store.save(video_id, "clips", clips)
        return {"checked": len(clips)}
    return _job("check", video_id, fn, pool=_render)


def cost(video_id: str) -> dict:
    return llm.video_cost(video_id)
