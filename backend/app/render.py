"""Render one clip variant to a 1080x1920 MP4 with FFmpeg: cut → reframe → speed/zoom → burned captions."""
import subprocess
from pathlib import Path

import numpy as np

from . import captions, reframe, store, timeline
from .config import FONTS, video_dir

OUT_W, OUT_H = 1080, 1920
DEFAULT_PLAN = {"style": "bold-pop", "hook_text": None, "zoom": 1.0, "speed": 1.0, "layout": "auto",
                "brand_text": None, "hook_seconds": 2.5}


def _even(x: float) -> int:
    return max(2, int(round(x / 2)) * 2)


def _filter_path(p: Path) -> str:
    """Escape a path for use inside an FFmpeg filter argument (works on Windows drive letters too)."""
    return str(p).replace("\\", "/").replace(":", r"\:").replace("'", r"\'")


def _piecewise(keys: list[tuple[float, float]], step: bool = False) -> str:
    """FFmpeg expression of t: linear interpolation (or steps) through (time, value) keyframes."""
    if len(keys) == 1:
        return str(int(keys[0][1]))
    expr = str(int(keys[-1][1]))
    for (t0, v0), (t1, v1) in reversed(list(zip(keys, keys[1:]))):
        seg = str(int(v0)) if step else f"{v0:.0f}+({v1 - v0:.0f})*(t-{t0:.2f})/{max(t1 - t0, 0.01):.2f}"
        expr = f"if(lt(t,{t1:.2f}),{seg},{expr})"
    return expr


def _smooth_track(path: list[tuple[float, float, float]], t0: float, W: int, H: int,
                  cw: int, ch: int) -> tuple[str, str]:
    """Follow a face with a dead zone (camera holds still for small moves) → x/y expressions of local t."""
    pts = [(t - t0, cx * W - cw / 2, cy * H - ch * 0.42) for t, cx, cy in path]
    if not pts:
        return str((W - cw) // 2), str((H - ch) // 2)
    xs = np.array([p[1] for p in pts])
    ys = np.array([p[2] for p in pts])
    k = 5  # median filter removes detection jitter
    if len(xs) >= k:
        xs = np.array([np.median(xs[max(0, i - k // 2): i + k // 2 + 1]) for i in range(len(xs))])
        ys = np.array([np.median(ys[max(0, i - k // 2): i + k // 2 + 1]) for i in range(len(ys))])
    clamp_x = lambda v: float(min(max(v, 0), W - cw))
    clamp_y = lambda v: float(min(max(v, 0), H - ch))
    keys_x, keys_y = [(0.0, clamp_x(xs[0]))], [(0.0, clamp_y(ys[0]))]
    dead_x, dead_y = 0.06 * W, 0.06 * H
    for (t, _, _), x, y in zip(pts, xs, ys):
        if abs(clamp_x(x) - keys_x[-1][1]) > dead_x and t - keys_x[-1][0] > 0.8:
            keys_x += [(t, keys_x[-1][1]), (t + 0.6, clamp_x(x))]   # hold, then glide over 0.6 s
        if abs(clamp_y(y) - keys_y[-1][1]) > dead_y and t - keys_y[-1][0] > 0.8:
            keys_y += [(t, keys_y[-1][1]), (t + 0.6, clamp_y(y))]
    return _piecewise(keys_x), _piecewise(keys_y)


def _face_crop(face_h: float, W: int, H: int, zoom: float) -> tuple[int, int]:
    """9:16 crop sized to the face: big faces → full height; small faces (grids, wide shots) → zoom in."""
    ch = min(H, max(face_h * H * 3.4, H * 0.45)) / zoom
    cw = ch * 9 / 16
    if cw > W:
        cw, ch = W, W * 16 / 9
    return _even(cw), _even(ch)


def layout_filter(lay: dict, t0: float, src: str, dst: str, W: int, H: int, zoom: float) -> str:
    """Filter chain [src] → [dst] for one shot piece starting at source time t0 (local t = source t - t0)."""
    kind = lay["layout"]
    tail = f"fps=30,format=yuv420p,setsar=1[{dst}]"
    if kind == "split":
        parts = []
        for k, tr in enumerate(lay["tracks"][:2]):
            rh = min(H, max(tr["h"] * H * 2.6, H * 0.42)) / zoom
            rw = rh * 9 / 8
            if rw > W:
                rw, rh = W, W * 8 / 9
            rw, rh = _even(rw), _even(rh)
            x = int(min(max(tr["cx"] * W - rw / 2, 0), W - rw))
            y = int(min(max(tr["cy"] * H - rh * 0.45, 0), H - rh))
            parts.append(f"[{dst}s{k}]crop={rw}:{rh}:{x}:{y},scale={OUT_W}:{OUT_H // 2}:flags=lanczos,setsar=1[{dst}p{k}]")
        return f"[{src}]split=2[{dst}s0][{dst}s1];{';'.join(parts)};[{dst}p0][{dst}p1]vstack,{tail}"
    if kind in ("track", "speaker"):
        face_h = float(np.median([tr["h"] for tr in lay["tracks"]]))
        cw, ch = _face_crop(face_h, W, H, zoom)
        if kind == "track":
            fx, fy = _smooth_track(lay["path"], t0, W, H, cw, ch)
        else:  # jump-cut to whoever is talking
            keys_x, keys_y = [], []
            for t_src, idx in lay["segments"]:
                tr = lay["tracks"][idx]
                t = 0.0 if not keys_x else max(t_src - t0, 0.0)
                keys_x.append((t, min(max(tr["cx"] * W - cw / 2, 0), W - cw)))
                keys_y.append((t, min(max(tr["cy"] * H - ch * 0.42, 0), H - ch)))
            fx, fy = _piecewise(keys_x, step=True), _piecewise(keys_y, step=True)
        return f"[{src}]crop={cw}:{ch}:'{fx}':'{fy}',scale={OUT_W}:{OUT_H}:flags=lanczos,{tail}"
    # fit: whole frame over a blurred, zoomed copy of itself
    fg_w = _even(OUT_W * zoom)
    return (f"[{src}]split=2[{dst}b0][{dst}f0];[{dst}b0]scale={OUT_W}:{OUT_H}:force_original_aspect_ratio=increase,"
            f"crop={OUT_W}:{OUT_H},gblur=sigma=28,eq=brightness=-0.10[{dst}bg];"
            f"[{dst}f0]scale={fg_w}:-2:flags=lanczos,crop=min(iw\\,{OUT_W}):ih[{dst}fg];"
            f"[{dst}bg][{dst}fg]overlay=(W-w)/2:(H-h)/2,{tail}")


def pieces(ranges: list[tuple[float, float]], shot_plans: list[dict]) -> list[tuple[float, float, dict]]:
    """Intersect kept ranges (text edits) with shots (layouts) → (start, end, layout) in source time."""
    out = []
    for s, e in ranges:
        for sp in shot_plans:
            a, b = max(s, sp["s"]), min(e, sp["e"])
            if b - a > 0.04:
                out.append((a, b, sp))
    if not out:  # ranges outside planned span (shouldn't happen): fall back to the first shot's layout
        out = [(s, e, shot_plans[0]) for s, e in ranges]
    return out


def render(video_id: str, clip: dict, plan: dict, out_path: Path, preview: bool = False) -> dict:
    plan = {**DEFAULT_PLAN, **{k: v for k, v in plan.items() if v is not None}}
    meta = store.load(video_id, "meta")
    t = store.load(video_id, "transcript")
    W, H = meta["width"], meta["height"]
    speed = float(plan["speed"])
    tl = timeline.build(clip, t["words"], speed)
    shot_plans = reframe.plan(video_id, tl.ranges[0][0], tl.ranges[-1][1], plan["layout"])
    # Captions sit on the split seam only if the clip is mostly split-screen.
    split_time = sum(sp["e"] - sp["s"] for sp in shot_plans if sp["layout"] == "split")
    caption_layout = "split" if split_time > 0.6 * (shot_plans[-1]["e"] - shot_plans[0]["s"]) else "track"

    words = timeline.output_words(clip, t["words"], tl)
    ass = captions.build_ass(words, plan["style"], tl.duration, caption_layout, plan.get("hook_text"),
                             plan.get("hook_seconds", 2.5), plan.get("brand_text"))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    ass_path = out_path.with_suffix(".ass")
    ass_path.write_text(ass, encoding="utf-8")

    seek = max(0.0, tl.ranges[0][0] - 2.0)  # fast seek to just before the clip, then exact trims
    fc = []
    vparts = pieces(tl.ranges, shot_plans)
    for k, (s, e, sp) in enumerate(vparts):
        fc.append(f"[0:v]trim=start={s - seek:.3f}:end={e - seek:.3f},setpts=PTS-STARTPTS[r{k}]")
        fc.append(layout_filter(sp, s, f"r{k}", f"v{k}", W, H, float(plan["zoom"])))
    for k, (s, e) in enumerate(tl.ranges):  # audio follows text-edit ranges only (no dips at shot changes)
        fc.append(f"[0:a]atrim=start={s - seek:.3f}:end={e - seek:.3f},asetpts=PTS-STARTPTS,"
                  f"afade=t=in:d=0.02,afade=t=out:st={max(e - s - 0.03, 0):.3f}:d=0.03[a{k}]")
    fc.append("".join(f"[v{k}]" for k in range(len(vparts))) + f"concat=n={len(vparts)}:v=1:a=0[vl]")
    fc.append("".join(f"[a{k}]" for k in range(len(tl.ranges))) + f"concat=n={len(tl.ranges)}:v=0:a=1[ac]")
    sub = f"subtitles=filename='{_filter_path(ass_path)}':fontsdir='{_filter_path(FONTS)}'"
    size = ",scale=540:960" if preview else ""
    fc.append(f"[vl]setpts=PTS/{speed},fps=30,{sub}{size}[vout]")
    fc.append(f"[ac]atempo={speed}[aout]" if speed != 1.0 else "[ac]anull[aout]")
    enc = ["-preset", "ultrafast", "-crf", "30"] if preview else ["-preset", "veryfast", "-crf", "20"]
    cmd = ["ffmpeg", "-v", "error", "-y", "-ss", f"{seek:.3f}", "-i", str(video_dir(video_id) / "source.mp4"),
           "-filter_complex", ";".join(fc), "-map", "[vout]", "-map", "[aout]",
           "-c:v", "libx264", *enc, "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k",
           "-movflags", "+faststart", str(out_path)]
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if p.returncode != 0:
        raise RuntimeError("FFmpeg failed: " + p.stderr[-2500:])
    return {"path": str(out_path), "duration": round(tl.duration, 2),
            "layouts": [sp["layout"] for sp in shot_plans], "ranges": tl.ranges, "plan": plan}
