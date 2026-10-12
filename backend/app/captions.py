"""Animated word-by-word captions + hook/brand overlays, written as an ASS subtitle file (burned in by FFmpeg)."""
import re

W, H = 1080, 1920

# ASS colours are &HAABBGGRR (alpha, blue, green, red).
STYLES = {
    "bold-pop": {"label": "Bold pop", "font": "Poppins ExtraBold", "size": 100, "upper": True, "max_words": 3,
                 "max_chars": 14, "primary": "&H00FFFFFF", "highlight": "&H0000E6FF", "outline": 7, "shadow": 0,
                 "border_style": 1, "back": "&H00000000", "anim": "pop"},
    "karaoke": {"label": "Karaoke sweep", "font": "Anton", "size": 112, "upper": True, "max_words": 4,
                "max_chars": 18, "primary": "&H0088FF39", "highlight": None, "secondary": "&H00FFFFFF",
                "outline": 6, "shadow": 2, "border_style": 1, "back": "&H80000000", "anim": "karaoke"},
    "boxed": {"label": "Boxed", "font": "Poppins Bold", "size": 78, "upper": False, "max_words": 4,
              "max_chars": 20, "primary": "&H00FFFFFF", "highlight": "&H0000D4FF", "outline": 14, "shadow": 0,
              "border_style": 3, "back": "&H30000000", "anim": "color"},
    "clean": {"label": "Clean minimal", "font": "Poppins SemiBold", "size": 68, "upper": False, "max_words": 7,
              "max_chars": 26, "primary": "&H00FFFFFF", "highlight": "&H00FFDB7F", "outline": 2, "shadow": 3,
              "border_style": 1, "back": "&H90000000", "anim": "color"},
}
CAPTION_STYLES = list(STYLES)


def _ts(t: float) -> str:
    t = max(t, 0)
    return f"{int(t // 3600)}:{int(t % 3600 // 60):02d}:{t % 60:05.2f}"


def _esc(s: str) -> str:
    return s.replace("\\", "/").replace("{", "(").replace("}", ")").replace("\n", " ")


def _wrap(words: list[str], max_chars: int) -> str:
    text = " ".join(words)
    if len(text) <= max_chars or len(words) < 2:
        return text
    best = min(range(1, len(words)), key=lambda k: abs(len(" ".join(words[:k])) - len(" ".join(words[k:]))))
    return " ".join(words[:best]) + r"\N" + " ".join(words[best:])


def group_words(words: list[dict], max_words: int, max_chars: int) -> list[list[dict]]:
    groups: list[list[dict]] = []
    cur: list[dict] = []
    for w in words:
        if cur and (len(cur) >= max_words or len(" ".join(x["w"] for x in cur + [w])) > max_chars * 2
                    or w["os"] - cur[-1]["oe"] > 0.6 or re.search(r"[.!?…]$", cur[-1]["w"])):
            groups.append(cur)
            cur = []
        cur.append(w)
    if cur:
        groups.append(cur)
    return groups


def _header(style: dict) -> str:
    sec = style.get("secondary", style["primary"])
    return f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,{style['font']},{style['size']},{style['primary']},{sec},&H00000000,{style['back']},0,0,0,0,100,100,1,0,{style['border_style']},{style['outline']},{style['shadow']},5,60,60,0,1
Style: Hook,Poppins ExtraBold,78,&H00111111,&H00111111,&H00FFFFFF,&H00FFFFFF,0,0,0,0,100,100,0,0,3,22,0,5,80,80,0,1
Style: Brand,Poppins Bold,42,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,3,1,5,40,40,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def build_ass(words: list[dict], style_name: str, duration: float, layout: str = "track",
              hook_text: str | None = None, hook_seconds: float = 2.5, brand_text: str | None = None) -> str:
    """`words` need output times `os`/`oe` (see timeline.output_words)."""
    style = STYLES.get(style_name, STYLES["bold-pop"])
    caption_y = 960 if layout == "split" else 1390   # split: on the seam between the two speakers
    hook_y = 330
    lines = [_header(style)]
    pos = rf"\pos({W // 2},{caption_y})"

    if style_name != "none":
        groups = group_words(words, style["max_words"], style["max_chars"])
        for gi, g in enumerate(groups):
            toks = [_esc(w["w"].upper() if style["upper"] else w["w"]) for w in g]
            g_end = g[-1]["oe"] + 0.12
            if gi + 1 < len(groups):  # never overlap the next group (they share one screen position)
                g_end = min(g_end, groups[gi + 1][0]["os"])
            if style["anim"] == "karaoke":
                parts = []
                for k, w in enumerate(g):
                    nxt = g[k + 1]["os"] if k + 1 < len(g) else w["oe"]
                    parts.append(rf"{{\kf{max(1, round((nxt - w['os']) * 100))}}}{toks[k]}")
                text = " ".join(parts)
                if len(" ".join(toks)) > style["max_chars"] and len(g) > 1:
                    half = len(g) // 2
                    text = " ".join(parts[:half]) + r"\N" + " ".join(parts[half:])
                lines.append(f"Dialogue: 1,{_ts(g[0]['os'])},{_ts(g_end)},Cap,,0,0,0,,{{{pos}}}{text}")
                continue
            for k, w in enumerate(g):
                start = w["os"] if k else g[0]["os"]
                end = g[k + 1]["os"] if k + 1 < len(g) else g_end
                styled = []
                for j, tok in enumerate(toks):
                    if j == k:
                        anim = r"\fscx112\fscy112\t(0,90,\fscx122\fscy122)\t(90,180,\fscx112\fscy112)" if style["anim"] == "pop" else ""
                        styled.append(rf"{{\c{style['highlight']}{anim}}}{tok}{{\r}}")
                    else:
                        styled.append(tok)
                text = " ".join(styled)
                plain = _wrap(toks, style["max_chars"])
                if r"\N" in plain:  # put the line break in the same place as the plain-text wrap
                    split_at = len(plain.split(r"\N")[0].split(" "))
                    text = " ".join(styled[:split_at]) + r"\N" + " ".join(styled[split_at:])
                lines.append(f"Dialogue: 1,{_ts(start)},{_ts(end)},Cap,,0,0,0,,{{{pos}}}{text}")

    if hook_text:
        hook = _wrap([_esc(x) for x in hook_text.split()], 20)
        lines.append(f"Dialogue: 2,{_ts(0)},{_ts(min(hook_seconds, duration))},Hook,,0,0,0,,"
                     rf"{{\pos({W // 2},{hook_y})\fad(80,200)\fscx80\fscy80\t(0,150,\fscx105\fscy105)\t(150,250,\fscx100\fscy100)}}{hook}")
    if brand_text:
        lines.append(f"Dialogue: 0,{_ts(0)},{_ts(duration)},Brand,,0,0,0,,{{\\pos({W // 2},{H - 150})}}{_esc(brand_text)}")
    return "\n".join(lines) + "\n"
