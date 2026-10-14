/**
 * Pure FFmpeg filtergraph builders for the brand finisher. No I/O: every function maps a plan to strings, so the
 * geometry/timing is unit-testable and the real-ffmpeg tests only have to prove the strings do what they claim.
 *
 * Timing model: every piece (intro, clip, outro) is cut to a whole number of frames and its audio to exactly the same
 * duration (padded with silence / trimmed), so the joined video and audio are the same length to the sample and the
 * watermark window (it is overlaid on the clip piece BEFORE the join) and the music bed line up with the pieces.
 */

export type PieceKind = 'intro' | 'clip' | 'outro';

export interface PlanPiece {
  kind: PieceKind;
  /** ffmpeg input index of the file. */
  inputIndex: number;
  /** Whole frames at the output fps. */
  frames: number;
  /** frames / fps. */
  sec: number;
  hasAudio: boolean;
}

export interface GraphPlan {
  canvas: { width: number; height: number };
  fps: number;
  /** fps as an ffmpeg expression (`30000/1001` for NTSC rates). */
  fpsExpr: string;
  /** In playback order. */
  pieces: PlanPiece[];
  watermark: {
    inputIndex: number;
    rect: { x: number; y: number; w: number; h: number };
    opacity: number;
  } | null;
  music: {
    inputIndex: number;
    /** Total gain applied to the (looped, trimmed) bed before ducking: loudness offset + the kit's gainDb. */
    gainDb: number;
    /** null = no ducking. */
    duckAmountDb: number | null;
    fadeInSec: number;
    fadeOutSec: number;
  } | null;
  /** Sum of the pieces' durations. */
  totalSec: number;
}

export const SAMPLE_RATE = 48_000;
/** sidechaincompress timing (ms). */
export const DUCK_ATTACK_MS = 20;
export const DUCK_RELEASE_MS = 350;
/**
 * The ducking key is the programme audio boosted hard and clipped at 0.5, i.e. a near-constant-level "speech present"
 * signal whatever the speech level. Its RMS as seen by sidechaincompress is about this many dB (measured, see tests),
 * which lets the threshold be derived from the wanted duck amount: reduction = (K - T) * (1 - 1/ratio).
 */
export const DUCK_KEY_LEVEL_DB = -6.3;
export const DUCK_KEY_PREGAIN_DB = 26;
export const DUCK_RATIO = 20;

const n6 = (v: number): string => (Math.round(v * 1e6) / 1e6).toString();

/** Snaps the common NTSC rates (printed as 29.97 / 23.976 / 59.94) to their exact rational. */
export function fpsExpression(fps: number): { fps: number; expr: string } {
  const ntsc: [number, string, number][] = [
    [23.976, '24000/1001', 24000 / 1001],
    [29.97, '30000/1001', 30000 / 1001],
    [47.952, '48000/1001', 48000 / 1001],
    [59.94, '60000/1001', 60000 / 1001],
  ];
  for (const [approx, expr, exact] of ntsc)
    if (Math.abs(fps - approx) < 0.006) return { fps: exact, expr };
  const r = Math.round(fps);
  if (Math.abs(fps - r) < 0.001) return { fps: r, expr: String(r) };
  return { fps, expr: n6(fps) };
}

/** Whole frames closest to `durSec` (at least 1) and the duration they make. */
export function frameAligned(durSec: number, fps: number): { frames: number; sec: number } {
  const frames = Math.max(1, Math.round(durSec * fps));
  return { frames, sec: frames / fps };
}

/** Filter label for a piece's video / audio. */
const vLabel = (i: number): string => `pv${i}`;
const aLabel = (i: number): string => `pa${i}`;

/**
 * Video: [piece chains] -> optional watermark on the clip piece -> hard-cut concat -> `[vout]`.
 * Intro/outro are fitted into the clip's canvas (contain, black bars) with square pixels at the clip's fps.
 */
export function buildVideoGraph(plan: GraphPlan): { graph: string; out: string } {
  const { width: W, height: H } = plan.canvas;
  const chains: string[] = [];
  plan.pieces.forEach((p, i) => {
    const f: string[] = [];
    if (p.kind !== 'clip') {
      // honour a non-square sample aspect ratio, then fit inside the canvas and letterbox
      f.push('scale=trunc(iw*sar/2)*2:ih');
      f.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2`);
      f.push(`pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`);
    }
    f.push(`fps=${plan.fpsExpr}`);
    f.push('setsar=1');
    f.push('format=yuv420p');
    // a source a hair short of the planned frame count repeats its last frame instead of shortening the join
    f.push('tpad=stop_mode=clone:stop=3');
    f.push(`trim=end_frame=${p.frames}`);
    f.push('setpts=PTS-STARTPTS');
    const isClipWithMark = p.kind === 'clip' && plan.watermark !== null;
    const label = isClipWithMark ? `${vLabel(i)}pre` : vLabel(i);
    chains.push(`[${p.inputIndex}:v:0]${f.join(',')}[${label}]`);
    if (isClipWithMark && plan.watermark) {
      const { rect, opacity, inputIndex } = plan.watermark;
      const wm = [
        'format=rgba',
        `scale=${rect.w}:${rect.h}:flags=lanczos`,
        ...(opacity < 0.9999 ? [`colorchannelmixer=aa=${n6(opacity)}`] : []),
      ];
      chains.push(`[${inputIndex}:v:0]${wm.join(',')}[wmk]`);
      chains.push(
        `[${label}][wmk]overlay=x=${rect.x}:y=${rect.y}:format=auto:eof_action=pass,` +
          `format=yuv420p,setsar=1[${vLabel(i)}]`,
      );
    }
  });
  if (plan.pieces.length === 1) {
    chains.push(`[${vLabel(0)}]null[vout]`);
  } else {
    const ins = plan.pieces.map((_, i) => `[${vLabel(i)}]`).join('');
    chains.push(`${ins}concat=n=${plan.pieces.length}:v=1:a=0[vout]`);
  }
  return { graph: chains.join(';'), out: 'vout' };
}

/** The ducking threshold (linear) giving ~`amountDb` of gain reduction under speech. */
export function duckThresholdLinear(amountDb: number): number {
  const reduction = Math.min(40, Math.max(0, amountDb));
  const thresholdDb = Math.max(-60, DUCK_KEY_LEVEL_DB - reduction / (1 - 1 / DUCK_RATIO));
  return 10 ** (thresholdDb / 20);
}

/**
 * Audio: every piece to 48 kHz stereo cut/padded to exactly its duration (silence for files without audio), joined,
 * then the optional music bed (looped input, trimmed, gain, fades, ducked by the joined programme) mixed in.
 * Ends in `[mix]`: NOT yet loudness-normalised (the caller measures then appends the linear loudnorm).
 */
export function buildAudioGraph(plan: GraphPlan): { graph: string; out: string } {
  const chains: string[] = [];
  plan.pieces.forEach((p, i) => {
    const d = n6(p.sec);
    if (p.hasAudio) {
      chains.push(
        `[${p.inputIndex}:a:0]aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,` +
          `apad=whole_dur=${d},atrim=end=${d},asetpts=PTS-STARTPTS[${aLabel(i)}]`,
      );
    } else {
      chains.push(
        `anullsrc=r=${SAMPLE_RATE}:cl=stereo,aformat=sample_fmts=fltp,atrim=end=${d},asetpts=PTS-STARTPTS[${aLabel(i)}]`,
      );
    }
  });
  if (plan.pieces.length === 1) {
    chains.push(`[${aLabel(0)}]anull[pa]`);
  } else {
    const ins = plan.pieces.map((_, i) => `[${aLabel(i)}]`).join('');
    chains.push(`${ins}concat=n=${plan.pieces.length}:v=0:a=1[pa]`);
  }
  const m = plan.music;
  if (!m) {
    chains.push('[pa]anull[mix]');
    return { graph: chains.join(';'), out: 'mix' };
  }
  const total = n6(plan.totalSec);
  const fadeIn = Math.min(Math.max(0, m.fadeInSec), plan.totalSec / 2);
  const fadeOut = Math.min(Math.max(0, m.fadeOutSec), plan.totalSec / 2);
  const bed = [
    `aresample=${SAMPLE_RATE}`,
    'aformat=sample_fmts=fltp:channel_layouts=stereo',
    `atrim=end=${total}`,
    'asetpts=PTS-STARTPTS',
    `volume=${n6(m.gainDb)}dB`,
    ...(fadeIn > 0.001 ? [`afade=t=in:st=0:d=${n6(fadeIn)}`] : []),
    ...(fadeOut > 0.001 ? [`afade=t=out:st=${n6(plan.totalSec - fadeOut)}:d=${n6(fadeOut)}`] : []),
  ];
  chains.push(`[${m.inputIndex}:a:0]${bed.join(',')}[bed]`);
  if (m.duckAmountDb !== null && m.duckAmountDb > 0.25) {
    chains.push('[pa]asplit=2[pam][pak]');
    chains.push(
      `[pak]highpass=f=120,volume=${DUCK_KEY_PREGAIN_DB}dB,alimiter=limit=0.5:attack=0.5:release=5:level=disabled[key]`,
    );
    chains.push(
      `[bed][key]sidechaincompress=threshold=${duckThresholdLinear(m.duckAmountDb).toPrecision(6)}` +
        `:ratio=${DUCK_RATIO}:attack=${DUCK_ATTACK_MS}:release=${DUCK_RELEASE_MS}:knee=1:makeup=1` +
        ':detection=rms:link=average[ducked]',
    );
    chains.push('[pam][ducked]amix=inputs=2:duration=first:normalize=0:dropout_transition=0[mix]');
  } else {
    chains.push('[pa][bed]amix=inputs=2:duration=first:normalize=0:dropout_transition=0[mix]');
  }
  return { graph: chains.join(';'), out: 'mix' };
}
