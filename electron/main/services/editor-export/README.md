# editor-export — Project JSON → FFmpeg

`createExportCompiler(opts?)` implements `ExportCompiler` (contracts3.ts). Semantics come ONLY from `shared/editor-eval.ts`
(called, never re-implemented). The graph is written to `<workDir>/graph.ffscript` (`-filter_complex_script`, flag
configurable: `filterScriptFlag: '-/filter_complex'` on ffmpeg ≥ 7). Output: H.264 yuv420p BT.709 limited, AAC 48 kHz.

## Mechanism

- **Sampling, not formulas.** Every animated number is sampled from the evaluator at each OUTPUT frame time `T = r0 + j/fps`,
  simplified (Douglas-Peucker) to a polyline whose knots are exact samples, and emitted as a log-depth `if(lt(t,..))` tree
  (`pl.ts`). Exact at knot frames, ≤ tol between: px 0.25, scale 0.002, deg 0.05, opacity 0.004, blur σ 0.12, crop px 0.02.
- **Per item** (`video.ts`): `-ss/-t` input → `setpts` G(c) (source→slot time) → `fps` on the global grid → `trim` to the item's
  frames → `tpad` hold → crop1 (integer window, may move) → `scale` (lanczos-free bicubic, may zoom) → crop2 (exact window,
  rounded at OUTPUT px) → `hflip` → colour → `rotate` → `gblur` → opacity → final `scale eval=frame` → `overlay` at a time-varying centre.
- **Stack**: tracks bottom→top. If the longest visual item is an opaque untransformed COVER picture the stack stays yuv420p
  (≈1.5× faster); otherwise rgba. Text/shapes/subtitles are ASS (`ass=…:alpha=1`) applied at their track's z-position.

## Shared-eval rule → FFmpeg

| rule                                               | construct                                                                                                                                           | measured error                     |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| naturalLayout cover/contain/native, crop keyframes | crop1/scale/crop2 (asset dims drive the layout, decoded dims drive sampling)                                                                        | ≤ 0.5 px                           |
| translate / uniform scale / rotate (cw)            | `overlay x=cx-w/2`, `scale eval=frame`, `rotate` (bilinear, transparent fill)                                                                       | ≤ 4 levels interior                |
| source time (speed, ramp, reverse, freeze)         | `setpts` PL map of consumed seconds; reverse = `reverse` per ≤4 s chunk + `concat`                                                                  | frame-exact; ramp+reverse ±1 frame |
| frame pick                                         | last source frame at or before the evaluator time (`fps round=near` + 0.49-slot bias)                                                               | 0.3 ms slack                       |
| colour exposure→contrast→saturation→temperature    | `lutrgb` · `colorchannelmixer` (Rec.709 luma) · `lutrgb`; animated = ≤ 60 `enable`-gated pieces                                                     | ≤ 4 levels                         |
| LUT                                                | `lut3d interp=trilinear`, mixed with `blend all_opacity` (top = LUT)                                                                                | —                                  |
| opacity × fades × ops                              | const → `colorchannelmixer aa`; animated → `alphaextract · eq(eval=frame) · alphamerge`                                                             | ≤ 4 levels                         |
| blur σ (item ⊕ ops, hypot)                         | `premultiply · gblur (gated pieces) · unpremultiply` before the final scale (σ/ratio)                                                               | —                                  |
| blend modes                                        | stack→gbrp, `blend` (stack = top operand), `maskedmerge` through the layer alpha                                                                    | ≤ 9 levels                         |
| transitions                                        | `activeOnTrack`+`transitionOps` per frame folded into each item's opacity/offset/scale/blur; dip veil = colour layer                                | ≤ 8 levels                         |
| text / shapes                                      | per-frame ASS events (merged when equal); `\fs = size·(ascent+descent)`, `\bord`, blurred shadow copy, `\p1` shapes (stroke = ring inside the rect) | ≤ 3 px                             |
| subtitles                                          | caption engine per item with the chunker neutralised → one block per cue, entrance at the cue start, last word stays active                         | —                                  |
| audio gain                                         | ONE `volume` PL per item: itemGainAt × track gain × `duckGainAt` × transition crossfade                                                             | ≤ 0.5 dB                           |
| speed/pitch                                        | `atempo` chains (preservePitch) / `asetrate`; ramps = ≤1/6 s segments `asplit`+`concat`                                                             | ±1 % pitch                         |
| loudness                                           | `measureLoudnessGraph` on the exact mix, then linear `loudnorm`                                                                                     | ±0.1 LU                            |

## Judgement calls (the preview mirrors these)

- hidden or muted tracks are inaudible; hidden tracks are not drawn; freeze frames are silent.
- audio crossfade in a transition overlap = linear gain ramps (from 1−p, to p); `cut` mutes the outgoing item.
- noise gate: `agate` thr −45 dB, ratio 10, 10/120 ms.
- untagged HD video is converted with BT.709 (tagged video keeps its tag); output tagged BT.709/tv.
- aspect mismatch between canvas and export: uniform scale, centred, padded with the background colour.
- arrow: shaft 40 % h, head min(w/2, 0.9h); stroke is an inside band; progress bar fills the left part of the natural rect.
- text lines wrap on the preview's rule; typewriter keeps layout and hides the unrevealed code points with `\alpha&HFF&`.

## Known gaps

- dip veil is a full-canvas colour layer (preview: src-atop over the transition layers) — equal when they cover the canvas.
- a transition group's blend is per layer, not the group's (`to`) blend; background-blur + non-normal blend blends each layer separately.
- crop SIZE animation with contain/native freezes the natural size at the first frame (notes say so).
- cues longer than the style's `maxLines` split into sequential blocks (caption chunker budget).
- reverse buffers ≤ 4 s chunks of canvas-size frames; very long reversed spans use several concurrent decoders.
