"""FastAPI app. Run: uvicorn backend.app.main:app --port 8000   then open http://localhost:8000"""
import shutil
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import boundaries, campaign, captions, moments, pipeline, store, timeline, variants
from .config import DATA, EFFORTS, MODEL_CHOICES, OUTPUT, ROOT, WHISPER_MODEL, api_key, claude_effort, claude_model, has_api_key, save_settings
from .llm import LLMError

app = FastAPI(title="Clipper")
FRONTEND = ROOT / "frontend"


@app.exception_handler(LLMError)
async def llm_error(_, exc: LLMError):
    from fastapi.responses import JSONResponse
    return JSONResponse(status_code=400, content={"detail": str(exc)})


# ---------- pages & media ----------

@app.get("/")
def index():
    return FileResponse(FRONTEND / "index.html")


app.mount("/static", StaticFiles(directory=FRONTEND), name="static")


@app.get("/media/{video_id}/{path:path}")
def media(video_id: str, path: str):
    p = (DATA / video_id / path).resolve()
    if not p.is_relative_to(DATA.resolve()) or not p.is_file():
        raise HTTPException(404)
    return FileResponse(p)


@app.get("/output/{path:path}")
def output_file(path: str):
    p = (OUTPUT / path).resolve()
    if not p.is_relative_to(OUTPUT.resolve()) or not p.is_file():
        raise HTTPException(404)
    return FileResponse(p)


def _config() -> dict:
    key = api_key()
    return {"has_api_key": has_api_key(), "key_hint": (key[:7] + "…" + key[-4:]) if len(key) > 12 else "",
            "model": claude_model(), "effort": claude_effort(), "whisper_model": WHISPER_MODEL,
            "models": {k: v["label"] for k, v in MODEL_CHOICES.items()}, "efforts": EFFORTS,
            "caption_styles": {k: v["label"] for k, v in captions.STYLES.items()},
            "layouts": ["auto", "track", "split", "speaker", "fit"]}


@app.get("/api/config")
def config():
    return _config()


class SettingsIn(BaseModel):
    api_key: str | None = None   # leave empty to keep the current key
    model: str | None = None
    effort: str | None = None


@app.post("/api/settings")
def settings(body: SettingsIn):
    """Saves to .env next to the code (git-ignored) and applies immediately: no restart needed."""
    if body.model and body.model not in MODEL_CHOICES:
        raise HTTPException(400, "Unknown model")
    if body.effort and body.effort not in EFFORTS:
        raise HTTPException(400, "Unknown effort")
    key = (body.api_key or "").strip()
    if key and not key.startswith("sk-ant-"):
        raise HTTPException(400, "That doesn't look like an Anthropic key (they start with sk-ant-)")
    save_settings(ANTHROPIC_API_KEY=key or None, CLIPPER_MODEL=body.model, CLIPPER_EFFORT=body.effort)
    if key:  # one tiny call so a bad key fails here, not mid-pipeline
        try:
            import anthropic
            anthropic.Anthropic(api_key=key, max_retries=1, timeout=30).models.retrieve(claude_model())
        except anthropic.AuthenticationError:
            save_settings(ANTHROPIC_API_KEY="")
            raise HTTPException(400, "Anthropic rejected that key. Copy it again from console.anthropic.com → API Keys.")
        except anthropic.APIStatusError as e:
            raise HTTPException(400, f"Key saved, but the API answered {e.status_code}: {e.message}")
        except anthropic.APIConnectionError:
            raise HTTPException(400, "Key saved, but the API could not be reached (network).")
    return _config()


# ---------- videos ----------

class UrlIn(BaseModel):
    url: str


@app.post("/api/videos")
def add_video(body: UrlIn):
    if not body.url.startswith(("http://", "https://")):
        raise HTTPException(400, "Paste a full video URL (https://…)")
    return pipeline.start_url(body.url.strip())


@app.post("/api/videos/upload")
async def upload_video(file: UploadFile = File(...), title: str | None = Form(None)):
    suffix = Path(file.filename or "video.mp4").suffix or ".mp4"
    tmp = Path(tempfile.mkdtemp(dir=DATA)) / f"upload{suffix}"
    with open(tmp, "wb") as f:
        shutil.copyfileobj(file.file, f)
    try:
        return pipeline.start_file(tmp, title or Path(file.filename or "upload").stem)
    finally:
        shutil.rmtree(tmp.parent, ignore_errors=True)


@app.get("/api/videos")
def videos():
    return store.list_videos()


def _video(video_id: str) -> dict:
    meta = store.load(video_id, "meta")
    if not meta:
        raise HTTPException(404, "Unknown video")
    return meta


@app.get("/api/videos/{video_id}")
def video(video_id: str):
    meta = _video(video_id)
    return {**meta, "status": store.load(video_id, "status", {}), "clips": store.load(video_id, "clips", []),
            "cost": pipeline.cost(video_id), "language": (store.load(video_id, "transcript") or {}).get("language")}


@app.get("/api/videos/{video_id}/transcript")
def transcript(video_id: str):
    t = store.load(video_id, "transcript")
    if not t:
        raise HTTPException(404, "No transcript yet")
    return t


@app.post("/api/videos/{video_id}/clip")
def reclip(video_id: str):
    _video(video_id)
    return pipeline.rerun_clipping(video_id)


class MomentsIn(BaseModel):
    query: str


@app.post("/api/videos/{video_id}/moments")
def find_moments(video_id: str, body: MomentsIn):
    _video(video_id)
    return moments.find_moments(video_id, body.query)


class AddClipIn(BaseModel):
    start_sentence: int
    end_sentence: int
    title: str = "Custom clip"
    hook_text: str | None = None
    why: str = "Added manually"


@app.post("/api/videos/{video_id}/clips")
def add_clip(video_id: str, body: AddClipIn):
    """Save a Find Moments result (or any sentence range) as a clip."""
    t = store.load(video_id, "transcript")
    snapped = boundaries.snap(t, body.start_sentence, body.end_sentence, min_len=5, max_len=180)
    if not snapped:
        raise HTTPException(400, "Could not make a clean clip from that range")
    clips = store.load(video_id, "clips", [])
    n = max([int(c["id"][1:]) for c in clips if c["id"][1:].isdigit()] + [0]) + 1
    clip = {"id": f"c{n:02d}", "category": "moment", "title": body.title, "hook_text": body.hook_text or body.title,
            "why": body.why, "payoff": "", **snapped,
            "text": boundaries.text_of(t, snapped["w0"], snapped["w1"])}
    clips.append(clip)
    store.save(video_id, "clips", clips)
    return clip


class ClipPatch(BaseModel):
    title: str | None = None
    hook_text: str | None = None
    style: str | None = None
    layout: str | None = None
    removed_words: list[int] | None = None
    start_sentence: int | None = None
    end_sentence: int | None = None


@app.patch("/api/videos/{video_id}/clips/{clip_id}")
def edit_clip(video_id: str, clip_id: str, body: ClipPatch):
    """Text-based editing + creative choices. Deleting words = list their indices in removed_words."""
    t = store.load(video_id, "transcript")
    clips = store.load(video_id, "clips", [])
    clip = next((c for c in clips if c["id"] == clip_id), None)
    if not clip:
        raise HTTPException(404, "Unknown clip")
    patch = body.model_dump(exclude_none=True)
    if "start_sentence" in patch or "end_sentence" in patch:
        snapped = boundaries.snap(t, patch.pop("start_sentence", clip["start_sentence"]),
                                  patch.pop("end_sentence", clip["end_sentence"]), min_len=3, max_len=180)
        if not snapped:
            raise HTTPException(400, "That range can't make a clean clip")
        clip.update(snapped)
        clip["text"] = boundaries.text_of(t, snapped["w0"], snapped["w1"])
        clip.pop("variants", None)
    if "removed_words" in patch:
        removed = [i for i in patch["removed_words"] if clip["w0"] <= i <= clip["w1"]]
        timeline.build({**clip, "removed_words": removed}, t["words"])  # raises if every word was removed
        patch["removed_words"] = removed
    if patch.get("style") and patch["style"] not in captions.STYLES and patch["style"] != "none":
        raise HTTPException(400, "Unknown caption style")
    clip.update(patch)
    tl = timeline.build(clip, t["words"])
    clip["edited_duration"] = round(tl.duration, 2)
    store.save(video_id, "clips", clips)
    return clip


@app.delete("/api/videos/{video_id}/clips/{clip_id}")
def delete_clip(video_id: str, clip_id: str):
    clips = [c for c in store.load(video_id, "clips", []) if c["id"] != clip_id]
    store.save(video_id, "clips", clips)
    return {"ok": True}


class PreviewIn(BaseModel):
    variant: int | None = None   # 1..3 uses that variant's settings; None = the clip's own settings


def _get_clip(video_id: str, clip_id: str) -> dict:
    clip = next((c for c in store.load(video_id, "clips", []) if c["id"] == clip_id), None)
    if not clip:
        raise HTTPException(404, "Unknown clip")
    return clip


@app.post("/api/videos/{video_id}/clips/{clip_id}/preview")
def preview(video_id: str, clip_id: str, body: PreviewIn):
    clip = _get_clip(video_id, clip_id)
    plan = {"style": clip.get("style", "bold-pop"), "hook_text": clip.get("hook_text"),
            "layout": clip.get("layout", "auto"), "brand_text": clip.get("brand_text")}
    if body.variant and clip.get("variants"):
        v = clip["variants"][body.variant - 1]
        clip = {**clip, **v.get("clip_patch", {})}
        plan = {**v["plan"], "brand_text": clip.get("brand_text")}
    return pipeline.preview(video_id, clip, plan)


class VariantsIn(BaseModel):
    campaign: str | None = None


@app.post("/api/videos/{video_id}/clips/{clip_id}/variants")
def make_variants(video_id: str, clip_id: str, body: VariantsIn):
    clips = store.load(video_id, "clips", [])
    clip = next((c for c in clips if c["id"] == clip_id), None)
    if not clip:
        raise HTTPException(404, "Unknown clip")
    rules = campaign.load_campaign(body.campaign) if body.campaign else None
    clip["variants"] = variants.build_variants(video_id, clip, rules)
    store.save(video_id, "clips", clips)
    return clip["variants"]


# ---------- campaigns ----------

class CampaignIn(BaseModel):
    brief: str
    name: str | None = None


@app.post("/api/campaigns")
def add_campaign(body: CampaignIn):
    if len(body.brief.strip()) < 20:
        raise HTTPException(400, "Paste the full campaign requirements")
    return campaign.parse_brief(body.brief, body.name)


@app.get("/api/campaigns")
def campaigns():
    return campaign.list_campaigns()


@app.post("/api/videos/{video_id}/check/{campaign_slug}")
def check(video_id: str, campaign_slug: str):
    if not campaign.load_campaign(campaign_slug):
        raise HTTPException(404, "Unknown campaign")
    return pipeline.check_campaign(video_id, campaign_slug)


class ExportIn(BaseModel):
    clip_ids: list[str]
    campaign: str | None = None
    variants: int = 3


@app.post("/api/videos/{video_id}/export")
def export(video_id: str, body: ExportIn):
    if not body.clip_ids:
        raise HTTPException(400, "Pick at least one clip")
    if body.campaign and not campaign.load_campaign(body.campaign):
        raise HTTPException(404, "Unknown campaign")
    return pipeline.export_many(video_id, body.clip_ids, body.campaign, max(1, min(3, body.variants)))


# ---------- jobs ----------

@app.get("/api/jobs/{job_id}")
def job(job_id: str):
    j = pipeline.JOBS.get(job_id)
    if not j:
        raise HTTPException(404, "Unknown job (the server may have restarted)")
    return j


@app.get("/api/jobs")
def jobs(video_id: str | None = None):
    return [j for j in pipeline.JOBS.values() if not video_id or j["video_id"] == video_id][-50:]
