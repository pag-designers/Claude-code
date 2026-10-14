/**
 * Subtitle cue operations (pure). A cue = one SubtitleItem whose words carry times LOCAL to the cue.
 */
import { subtitleItemSchema, type Item, type Project, type SubtitleItem, type SubtitleWord, type Track } from '@shared/editor';
import { itemEnd } from '@shared/editor-eval';
import { newId } from '../helpers';
import { Draft, EPS, MIN_DUR, clamp, isItemLocked, layoutProblem, locate, normalizeItems, trackIndexOf } from './common';
import { replaceItem } from './keyframes';

const MIN_WORD = 0.12;

export const tokenize = (text: string): string[] => text.trim().split(/\s+/).filter(Boolean);

/** Matched (oldIdx, newIdx) pairs of the longest common subsequence of two token lists. */
function lcsPairs(a: readonly string[], b: readonly string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      (dp[i] as Uint16Array)[j] =
        a[i] === b[j]
          ? ((dp[i + 1] as Uint16Array)[j + 1] as number) + 1
          : Math.max((dp[i + 1] as Uint16Array)[j] as number, (dp[i] as Uint16Array)[j + 1] as number);
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push([i, j]);
      i++;
      j++;
    } else if (((dp[i + 1] as Uint16Array)[j] as number) >= ((dp[i] as Uint16Array)[j + 1] as number)) i++;
    else j++;
  }
  return out;
}

/** Spread `tokens` over [s, e] proportionally to their length. */
function spread(tokens: readonly string[], s: number, e: number): SubtitleWord[] {
  const weights = tokens.map((t) => Array.from(t).length + 1);
  const total = weights.reduce((x, y) => x + y, 0);
  const span = Math.max(0, e - s);
  let acc = s;
  return tokens.map((w, k) => {
    const dur = (span * (weights[k] as number)) / total;
    const word: SubtitleWord = { w, s: acc, e: k === tokens.length - 1 ? s + span : acc + dur, color: null };
    acc += dur;
    return word;
  });
}

/**
 * New text for a cue. Unchanged words keep their timing (LCS diff); a replaced run takes over the span of the
 * words it replaces; inserted words share the gap between their neighbours, borrowing time from them when the gap
 * is too small; with no old words the new ones share the whole cue.
 */
export function retimeWordsForText(old: readonly SubtitleWord[], text: string, cueDur: number): SubtitleWord[] {
  const nw = tokenize(text);
  if (!nw.length) return [];
  if (!old.length) return spread(nw, 0, cueDur);
  const pairs = lcsPairs(
    old.map((w) => w.w),
    nw,
  );
  const out: SubtitleWord[] = [];
  let po = -1;
  let pn = -1;
  const fill = (oi: number, ni: number, nextAnchor: SubtitleWord | null): SubtitleWord | null => {
    // new tokens (pn, ni) against old tokens (po, oi); returns the (possibly adjusted) next anchor
    const toks = nw.slice(pn + 1, ni);
    if (!toks.length) return nextAnchor;
    const replaced = old.slice(po + 1, oi);
    if (replaced.length) {
      const s = (replaced[0] as SubtitleWord).s;
      const e = (replaced[replaced.length - 1] as SubtitleWord).e;
      out.push(...spread(toks, s, Math.max(e, s + 0.001)));
      return nextAnchor;
    }
    const prev = out[out.length - 1] ?? null;
    let anchor = nextAnchor;
    const lo = prev ? prev.e : 0;
    const hi = anchor ? anchor.s : cueDur;
    let s = lo;
    let e = hi;
    const need = toks.length * MIN_WORD;
    if (e - s < need) {
      // Not enough room: borrow from both neighbours (at most half of either word), preferring an even split.
      const borrow = need - (e - s);
      const capPrev = prev ? (prev.e - prev.s) * 0.5 : 0;
      const capNext = anchor ? (anchor.e - anchor.s) * 0.5 : 0;
      let tp = Math.min(capPrev, borrow / 2);
      const tn = Math.min(capNext, borrow - tp);
      tp = Math.min(capPrev, borrow - tn);
      if (prev && tp > 0) {
        out[out.length - 1] = { ...prev, e: prev.e - tp };
        s = prev.e - tp;
      }
      if (anchor && tn > 0) {
        anchor = { ...anchor, s: anchor.s + tn };
        e = anchor.s;
      }
      if (e < s) e = s;
    }
    out.push(...spread(toks, s, e));
    return anchor;
  };
  for (const [oi, ni] of pairs) {
    let anchor: SubtitleWord | null = old[oi] as SubtitleWord;
    anchor = fill(oi, ni, anchor);
    out.push(anchor as SubtitleWord);
    po = oi;
    pn = ni;
  }
  fill(old.length, nw.length, null);
  // keep words ordered and inside the cue
  let last = 0;
  return out.map((w) => {
    const s = clamp(Math.max(w.s, last), 0, cueDur);
    const e = clamp(Math.max(w.e, s), s, cueDur);
    last = s;
    return { ...w, s, e };
  });
}

function cueAt(p: Project, id: string) {
  const loc = locate(p, id);
  if (!loc || loc.item.type !== 'subtitle' || isItemLocked(loc.track, loc.item)) return null;
  return { loc, cue: loc.item };
}

export function setCueTextOp(p: Project, itemId: string, text: string): Project {
  const c = cueAt(p, itemId);
  if (!c) return p;
  const tokens = tokenize(text);
  if (tokens.length === c.cue.words.length && tokens.every((t, k) => t === (c.cue.words[k] as SubtitleWord).w))
    return p;
  return replaceItem(p, c.loc, { ...c.cue, words: retimeWordsForText(c.cue.words, text, c.cue.durationSec) });
}

/** Words [0, atWordIndex) stay; the rest become a new cue directly after (split at the gap between them). */
export function splitCueOp(
  p: Project,
  itemId: string,
  atWordIndex: number,
): { project: Project; newId: string | null } {
  const c = cueAt(p, itemId);
  const none = { project: p, newId: null };
  if (!c) return none;
  const { cue, loc } = c;
  const n = cue.words.length;
  if (!Number.isInteger(atWordIndex) || atWordIndex < 1 || atWordIndex > n - 1) return none;
  const lw = cue.words.slice(0, atWordIndex);
  const rw = cue.words.slice(atWordIndex);
  const leftEnd = (lw[lw.length - 1] as SubtitleWord).e;
  const rightStart = (rw[0] as SubtitleWord).s;
  const t = clamp((leftEnd + rightStart) / 2, MIN_DUR, cue.durationSec - MIN_DUR);
  if (t < MIN_DUR - 1e-9 || cue.durationSec - t < MIN_DUR - 1e-9) return none;
  const id = newId('it');
  const left: SubtitleItem = {
    ...cue,
    durationSec: t,
    words: lw.map((w) => ({ ...w, s: Math.min(w.s, t), e: Math.min(w.e, t) })),
  };
  const right: SubtitleItem = {
    ...cue,
    id,
    startSec: cue.startSec + t,
    durationSec: cue.durationSec - t,
    words: rw.map((w) => ({ ...w, s: Math.max(0, w.s - t), e: Math.max(0, w.e - t) })),
  };
  const d = new Draft(p);
  const w = d.items(loc.ti);
  w[loc.i] = left;
  w.splice(loc.i + 1, 0, right);
  return { project: d.result(), newId: id };
}

/** Merge a cue with the next cue on its track (the gap between them is absorbed into the first cue's span). */
export function mergeCueWithNextOp(p: Project, itemId: string): Project {
  const c = cueAt(p, itemId);
  if (!c) return p;
  const { cue, loc } = c;
  const next = loc.track.items[loc.i + 1];
  if (!next || next.type !== 'subtitle' || isItemLocked(loc.track, next)) return p;
  const off = next.startSec - cue.startSec;
  const merged: SubtitleItem = {
    ...cue,
    durationSec: itemEnd(next) - cue.startSec,
    words: [...cue.words, ...next.words.map((w) => ({ ...w, s: w.s + off, e: w.e + off }))],
  };
  const d = new Draft(p);
  const w = d.items(loc.ti);
  w[loc.i] = merged;
  w.splice(loc.i + 1, 1);
  return d.result();
}

/**
 * Drag a cue's edges to [startSec, endSec]: the cue keeps its words' relative timing (rescaled to the new length).
 * Limited by the neighbouring cues and 0; minimum length MIN_DUR.
 */
export function retimeCueOp(p: Project, itemId: string, startSec: number, endSec: number): Project {
  const c = cueAt(p, itemId);
  if (!c || !Number.isFinite(startSec) || !Number.isFinite(endSec)) return p;
  const { cue, loc } = c;
  const prev = loc.track.items[loc.i - 1];
  const next = loc.track.items[loc.i + 1];
  const lo = Math.max(0, prev ? itemEnd(prev) : 0);
  const hi = next ? next.startSec : Infinity;
  let s = clamp(startSec, lo, hi - MIN_DUR);
  let e = clamp(endSec, s + MIN_DUR, hi);
  if (e - s < MIN_DUR) {
    s = e - MIN_DUR;
    if (s < lo) return p;
  }
  const dur = e - s;
  if (Math.abs(s - cue.startSec) < 1e-9 && Math.abs(dur - cue.durationSec) < 1e-9) return p;
  const k = dur / cue.durationSec;
  return replaceItem(p, loc, {
    ...cue,
    startSec: s,
    durationSec: dur,
    words: cue.words.map((w) => ({ ...w, s: w.s * k, e: w.e * k })),
  });
}

/**
 * Replace all cues of a subtitle track. Non-subtitle / invalid entries are dropped; ids are kept unless they would
 * collide with an item elsewhere; cues are sorted and any overlap is resolved by shortening the earlier cue.
 */
export function replaceCuesOp(p: Project, trackId: string, cues: readonly Item[]): Project {
  const ti = trackIndexOf(p, trackId);
  if (ti < 0) return p;
  const tr = p.tracks[ti] as Track;
  if (tr.locked || tr.kind !== 'subtitle') return p;
  const other = new Set<string>();
  p.tracks.forEach((t, k) => {
    if (k !== ti) for (const it of t.items) other.add(it.id);
  });
  const seen = new Set<string>();
  const next: Item[] = [];
  for (const c of cues) {
    const parsed = subtitleItemSchema.safeParse(c);
    if (!parsed.success) continue;
    let it: SubtitleItem = c as SubtitleItem;
    if (other.has(it.id) || seen.has(it.id)) it = { ...it, id: newId('it') };
    seen.add(it.id);
    next.push(it);
  }
  normalizeItems(next);
  for (let k = 0; k < next.length - 1; k++) {
    const a = next[k] as Item;
    const b = next[k + 1] as Item;
    if (itemEnd(a) > b.startSec + EPS) {
      const dur = b.startSec - a.startSec;
      next[k] =
        dur >= MIN_DUR
          ? ({ ...a, durationSec: dur } as Item)
          : ({ ...a, durationSec: MIN_DUR, startSec: Math.max(0, b.startSec - MIN_DUR) } as Item);
    }
  }
  if (layoutProblem(next)) return p;
  const tracks = p.tracks.slice();
  tracks[ti] = { ...tr, items: next };
  return { ...p, tracks };
}
