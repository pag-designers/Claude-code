"""Export bundle: output/<campaign>/<clip>/ → clip.mp4, variant-2.mp4, variant-3.mp4, caption.txt, requirements-checklist.md."""
from pathlib import Path

from . import campaign as campaign_mod, render, store, variants as variants_mod
from .config import OUTPUT


def _clip_by_id(video_id: str, clip_id: str) -> dict:
    for c in store.load(video_id, "clips", []):
        if c["id"] == clip_id:
            return c
    raise KeyError(f"clip {clip_id} not found")


def export_clip(video_id: str, clip_id: str, campaign_slug: str | None = None, n_variants: int = 3,
                on_progress=None) -> dict:
    t = store.load(video_id, "transcript")
    clip = _clip_by_id(video_id, clip_id)
    rules = campaign_mod.load_campaign(campaign_slug) if campaign_slug else None
    fixes: list[str] = []
    if rules:
        clip, fixes = campaign_mod.apply_fixes(t, clip, rules)
    vs = variants_mod.apply_rules(clip.get("variants") or variants_mod.build_variants(video_id, clip, rules), rules)
    folder = OUTPUT / (rules["slug"] if rules else "no-campaign") / f"{clip_id}-{campaign_mod.slug(clip.get('title', ''))[:40]}"
    folder.mkdir(parents=True, exist_ok=True)
    files, all_rows = [], {}
    for k, v in enumerate(vs[:n_variants]):
        c = {**clip, **v.get("clip_patch", {})}
        if rules:  # recompute this variant's cut point inside the campaign limits, then re-apply fixes
            patch = variants_mod._cut(t, clip, variants_mod.PRESETS[k]["cut"], rules) if k < len(variants_mod.PRESETS) else {}
            c = campaign_mod.apply_fixes(t, {**clip, **patch}, rules)[0] if patch else clip
        plan = {**v["plan"], "brand_text": clip.get("brand_text")}
        if k == 0:  # variant 1 keeps any manual edits from the editor (style, hook, layout)
            plan.update({x: clip[x] for x in ("style", "hook_text", "layout") if clip.get(x)})
        if clip.get("speed"):
            plan["speed"] = max(float(plan.get("speed", 1.0)), float(clip["speed"]))
        if rules:  # keep each variant's speed inside the campaign's length limits
            base = sum(e - s for s, e in render.timeline.build(c, t["words"]).ranges)
            if rules.get("max_seconds"):
                plan["speed"] = max(plan["speed"], base / (rules["max_seconds"] - 0.3))
            if rules.get("min_seconds"):
                plan["speed"] = min(plan["speed"], max(1.0, base / (rules["min_seconds"] + 0.3)))
            plan["speed"] = round(min(plan["speed"], 1.15), 3)
        name = "clip.mp4" if k == 0 else f"variant-{k + 1}.mp4"
        info = render.render(video_id, c, plan, folder / name)
        (folder / name).with_suffix(".ass").unlink(missing_ok=True)
        files.append(name)
        if rules:
            all_rows[name] = campaign_mod.check_clip(t, c, rules, {"duration": info["duration"], "style": plan["style"]},
                                                     v["posts"])
        if on_progress:
            on_progress((k + 1) / n_variants)
    (folder / "caption.txt").write_text(variants_mod.caption_txt(clip, vs[:n_variants]), encoding="utf-8")
    if rules:
        ai = campaign_mod.ai_checks(video_id, t, [clip], rules).get(clip["id"], [])
        md = []
        for name, rows in all_rows.items():
            md.append(f"<!-- {name} -->\n" + campaign_mod.checklist_md({**clip, "title": f"{clip.get('title', '')} ({name})"},
                                                                     rules, rows + ai, fixes))
        (folder / "requirements-checklist.md").write_text("\n\n---\n\n".join(md), encoding="utf-8")
    store.write_json(folder / "metadata.json", {"video_id": video_id, "clip": clip, "variants": vs[:n_variants],
                                                "campaign": rules and rules["slug"], "fixes": fixes})
    return {"folder": str(folder.relative_to(OUTPUT.parent)), "files": files + ["caption.txt"]
            + (["requirements-checklist.md"] if rules else [])}
