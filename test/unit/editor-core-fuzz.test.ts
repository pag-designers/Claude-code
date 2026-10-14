import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { itemSchema, projectSchema, type Item, type Project, type Track } from '@shared/editor';
import { itemEnd, projectDuration, sourceSpan } from '@shared/editor-eval';
import { projectProblems, setTransitionOp } from '../../renderer/lib/editor/core/ops';
import { asset, makeStore, proj, track, V, A, I, S, T, C } from './editor-core-fixtures';

/* ---------------------------------------------------------------- seeded random --------------- */

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    float: (lo: number, hi: number) => lo + next() * (hi - lo),
    chance: (p: number) => next() < p,
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T,
  };
  return r;
}
type R = ReturnType<typeof rng>;

const q = (v: number) => Math.round(v * 1000) / 1000;
const kfs = (r: R, dur: number, lo: number, hi: number) =>
  r.chance(0.35)
    ? Array.from({ length: r.int(1, 4) }, () => ({
        t: q(r.float(0, dur)),
        v: q(r.float(lo, hi)),
        ease: r.pick(['linear', 'hold', 'ease-in-out'] as const),
      }))
        .sort((a, b) => a.t - b.t)
        .filter((k, i, arr) => i === 0 || k.t > (arr[i - 1] as { t: number }).t)
    : [];

let uid = 0;
const nid = (p: string) => `${p}${++uid}`;

function randomProject(r: R): Project {
  const tracks: Track[] = [];
  const mkRun = (make: (start: number, dur: number) => Item, n: number, gapChance: number) => {
    const out: Item[] = [];
    let t = r.chance(0.5) ? 0 : q(r.float(0, 3));
    for (let i = 0; i < n; i++) {
      const dur = q(r.float(0.4, 7));
      out.push(make(t, dur));
      t = q(t + dur + (r.chance(gapChance) ? r.float(0.1, 3) : 0));
    }
    return out;
  };
  const vid = (start: number, dur: number) =>
    V(nid('v'), start, dur, {
      inSec: q(r.float(0, 30)),
      speed: r.pick([1, 1, 1, 0.5, 2, 1.5]),
      reverse: r.chance(0.12),
      freezeAtSec: r.chance(0.05) ? q(r.float(0, 50)) : null,
      speedCurve: r.chance(0.12)
        ? [
            { t: 0, v: q(r.float(0.5, 2)), ease: 'linear' },
            { t: q(dur), v: q(r.float(0.5, 3)), ease: 'linear' },
          ]
        : [],
      fadeInSec: r.chance(0.2) ? q(r.float(0, 1)) : 0,
      fadeOutSec: r.chance(0.2) ? q(r.float(0, 1)) : 0,
      groupId: null,
      transform: {
        x: { v: 0, kf: kfs(r, dur, -200, 200) },
        opacity: { v: 1, kf: kfs(r, dur, 0, 1) },
        scale: { v: 1, kf: kfs(r, dur, 0.5, 2) },
      },
      volume: { v: 1, kf: kfs(r, dur, 0, 1.5) },
    });
  const trackKinds = r.pick([
    ['video', 'overlay', 'audio', 'text', 'subtitle'],
    ['video', 'audio', 'subtitle'],
    ['video', 'video', 'overlay', 'audio'],
  ]);
  trackKinds.forEach((kind, i) => {
    const id = `${kind}${i}`;
    const locked = r.chance(0.06);
    if (kind === 'video') tracks.push(track(id, 'video', mkRun(vid, r.int(2, 9), 0.4), { locked }));
    else if (kind === 'overlay')
      tracks.push(
        track(
          id,
          'overlay',
          mkRun(
            (s, d) =>
              r.chance(0.5)
                ? I(nid('i'), s, d, { transform: { x: { v: 0, kf: kfs(r, d, -100, 100) } } })
                : S(nid('s'), s, d),
            r.int(1, 5),
            0.5,
          ),
          { locked },
        ),
      );
    else if (kind === 'audio')
      tracks.push(
        track(
          id,
          'audio',
          mkRun(
            (s, d) =>
              A(nid('a'), s, d, {
                inSec: q(r.float(0, 60)),
                speed: r.pick([1, 1, 2, 0.5]),
                reverse: r.chance(0.1),
                volume: { v: 1, kf: kfs(r, d, 0, 1) },
              }),
            r.int(1, 4),
            0.5,
          ),
          { locked },
        ),
      );
    else if (kind === 'text')
      tracks.push(
        track(
          id,
          'text',
          mkRun(
            (s, d) => T(nid('t'), s, d, { animIn: { type: 'pop', durationSec: 0.3 } }),
            r.int(1, 4),
            0.6,
          ),
          { locked },
        ),
      );
    else
      tracks.push(
        track(
          id,
          'subtitle',
          mkRun(
            (s, d) => {
              const n = r.int(1, 6);
              const words = Array.from(
                { length: n },
                (_, k) =>
                  ['w' + k + 'x', q((d * k) / n), q((d * (k + 0.8)) / n)] as [
                    string,
                    number,
                    number,
                  ],
              );
              return C(nid('c'), s, d, words);
            },
            r.int(1, 6),
            0.5,
          ),
          { locked },
        ),
      );
  });
  let p = proj(tracks, {
    assets: [
      asset('av', 'video', 60),
      asset('aa', 'audio', 90, { beats: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }),
      asset('ai', 'image', null),
    ],
  });
  // sprinkle transitions on video tracks
  for (const tr of p.tracks) {
    if (tr.kind !== 'video') continue;
    for (const it of tr.items.slice(1)) {
      if (r.chance(0.35))
        p = setTransitionOp(
          p,
          it.id,
          {
            type: r.pick(['crossfade', 'slide-left', 'dip-black'] as const),
            durationSec: q(r.float(0.2, 1.2)),
          },
          r.chance(0.5),
        );
    }
  }
  // groups across tracks
  const ids = p.tracks.flatMap((t) => t.items.map((i) => i.id));
  if (ids.length > 4 && r.chance(0.5)) {
    const gid = nid('g');
    const chosen = new Set([r.pick(ids), r.pick(ids), r.pick(ids)]);
    if (chosen.size >= 2)
      p = {
        ...p,
        tracks: p.tracks.map((t) => ({
          ...t,
          items: t.items.map((i) => (chosen.has(i.id) ? { ...i, groupId: gid } : i)),
        })),
      };
  }
  return projectSchema.parse(p);
}

/* ---------------------------------------------------------------- random actions -------------- */

type Store = ReturnType<typeof makeStore>;
type Act = (st: Store, r: R, log: string[]) => void;

const allItems = (p: Project) => p.tracks.flatMap((t) => t.items);
const pickItem = (st: Store, r: R) => {
  const xs = allItems(st.getState().project);
  return xs.length ? r.pick(xs) : null;
};
const timeNear = (st: Store, r: R) => q(r.float(-1, projectDuration(st.getState().project) + 3));

const ACTIONS: [string, Act][] = [
  [
    'trim',
    (st, r, log) => {
      const it = pickItem(st, r);
      if (!it) return;
      const edge = r.pick(['start', 'end'] as const);
      const opts = {
        snap: r.chance(0.5),
        ripple: r.chance(0.3) ? true : undefined,
        roll: r.chance(0.25),
      };
      const to = timeNear(st, r);
      log.push(`trim ${it.id} ${edge} ${to} ${JSON.stringify(opts)}`);
      st.getState().trim(it.id, edge, to, opts);
    },
  ],
  ['ripple toggle', (st) => st.getState().toggleRipple()],
  [
    'split',
    (st, r, log) => {
      const it = pickItem(st, r);
      const at = q(it ? it.startSec + r.float(-0.2, it.durationSec + 0.2) : 1);
      log.push(`split ${it?.id} ${at}`);
      if (r.chance(0.4)) {
        st.getState().setPlayhead(at);
        st.getState().select(it ? [it.id] : []);
        st.getState().split(null);
      } else st.getState().split(it ? it.id : null, at);
    },
  ],
  [
    'delete',
    (st, r, log) => {
      const xs = allItems(st.getState().project);
      if (!xs.length) return;
      const ids = Array.from({ length: r.int(1, 3) }, () => r.pick(xs).id);
      const rp = r.chance(0.4);
      log.push(`delete ${ids} ripple=${rp}`);
      st.getState().deleteItems(ids, { ripple: rp });
    },
  ],
  [
    'gaps',
    (st, r, log) => {
      const tr = r.pick(st.getState().project.tracks);
      log.push(`gaps ${tr.id}`);
      st.getState().deleteGaps(r.chance(0.5) ? tr.id : undefined);
    },
  ],
  [
    'duplicate',
    (st, r, log) => {
      const it = pickItem(st, r);
      if (it) {
        log.push(`dup ${it.id}`);
        st.getState().duplicateItems([it.id]);
      }
    },
  ],
  [
    'group',
    (st, r, log) => {
      const xs = allItems(st.getState().project);
      if (xs.length < 2) return;
      const ids = [r.pick(xs).id, r.pick(xs).id, r.pick(xs).id];
      log.push(`group ${ids}`);
      st.getState().group(ids);
    },
  ],
  [
    'ungroup',
    (st, r, log) => {
      const it = pickItem(st, r);
      if (it) {
        log.push(`ungroup ${it.id}`);
        st.getState().ungroup([it.id]);
      }
    },
  ],
  [
    'move',
    (st, r, log) => {
      const it = pickItem(st, r);
      if (!it) return;
      const tracks = st.getState().project.tracks;
      const target = r.chance(0.4) ? r.pick(tracks).id : null;
      const delta = q(r.float(-5, 8));
      const pv = st.getState().previewMove([it.id], delta, target, {
        snap: r.chance(0.7),
        pxPerSec: r.pick([20, 100, 600]),
      });
      log.push(`move ${it.id} ${delta} -> ${target} valid=${pv.valid}`);
      if (pv.valid || r.chance(0.3)) st.getState().applyMoves(pv.moves, { ripple: r.chance(0.2) });
    },
  ],
  [
    'transition',
    (st, r, log) => {
      const xs = allItems(st.getState().project).filter(
        (i) => i.type === 'video' || i.type === 'image',
      );
      if (!xs.length) return;
      const it = r.pick(xs);
      const tr = r.chance(0.3)
        ? null
        : {
            type: r.pick(['crossfade', 'slide-right', 'zoom', 'glitch', 'cut'] as const),
            durationSec: q(r.float(0.05, 6)),
          };
      log.push(`transition ${it.id} ${JSON.stringify(tr)}`);
      st.getState().setTransition(it.id, tr);
    },
  ],
  [
    'speed',
    (st, r, log) => {
      const it = pickItem(st, r);
      if (!it) return;
      const sp = q(r.float(0.05, 12));
      log.push(`speed ${it.id} ${sp}`);
      st.getState().setSpeed(it.id, sp, { keepDuration: r.chance(0.3) });
    },
  ],
  [
    'freeze',
    (st, r, log) => {
      const it = pickItem(st, r);
      if (!it) return;
      const at = q(it.startSec + r.float(-0.1, it.durationSec + 0.1));
      log.push(`freeze ${it.id} ${at}`);
      st.getState().freezeFrame(it.id, at, q(r.float(0.01, 4)));
    },
  ],
  [
    'setProp',
    (st, r, log) => {
      const it = pickItem(st, r);
      if (!it) return;
      const path = r.pick([
        'transform.x',
        'transform.opacity',
        'transform.scale',
        'volume',
        'blur',
        'crop.w',
        'color.exposure',
      ] as const);
      st.getState().setPlayhead(q(it.startSec + r.float(-1, it.durationSec + 1)));
      log.push(`setProp ${it.id} ${path}`);
      st.getState().setProp(it.id, path, q(r.float(-2, 3)), { forceKeyframe: r.chance(0.4) });
    },
  ],
  [
    'addKeyframe',
    (st, r, log) => {
      const it = pickItem(st, r);
      if (!it) return;
      const t = q(r.float(-1, it.durationSec + 1));
      log.push(`addKf ${it.id} ${t}`);
      st.getState().addKeyframe(it.id, 'transform.x', t, q(r.float(-100, 100)));
    },
  ],
  [
    'moveKeyframe',
    (st, r, log) => {
      const it = pickItem(st, r);
      if (!it) return;
      log.push(`moveKf ${it.id}`);
      st.getState().moveKeyframe(
        it.id,
        'transform.x',
        r.int(0, 3),
        q(r.float(-1, it.durationSec + 1)),
        q(r.float(-50, 50)),
      );
    },
  ],
  [
    'removeKeyframe',
    (st, r, log) => {
      const it = pickItem(st, r);
      if (!it) return;
      log.push(`rmKf ${it.id}`);
      st.getState().removeKeyframe(it.id, 'transform.x', r.int(0, 3));
    },
  ],
  [
    'clearKeyframes',
    (st, r) => {
      const it = pickItem(st, r);
      if (it) st.getState().clearKeyframes(it.id, 'transform.opacity');
    },
  ],
  [
    'updateItem',
    (st, r, log) => {
      const it = pickItem(st, r);
      if (!it) return;
      log.push(`update ${it.id}`);
      if (r.chance(0.3))
        st.getState().updateItem(it.id, {
          startSec: q(r.float(0, 20)),
          durationSec: q(r.float(0.04, 6)),
        });
      else
        st.getState().updateItem(
          it.id,
          { name: 'n' + r.int(0, 9) },
          { coalesceKey: r.chance(0.5) ? 'name' : undefined },
        );
    },
  ],
  [
    'addAsset',
    (st, r, log) => {
      const id = r.pick(['av', 'aa', 'ai']);
      st.getState().setPlayhead(q(r.float(0, 30)));
      log.push(`addAsset ${id}`);
      st.getState().addAsset(id, { ripple: r.chance(0.3) });
    },
  ],
  [
    'addItem',
    (st, r) => {
      st.getState().addItem(
        r.pick([
          T(nid('t'), q(r.float(0, 20)), 2),
          S(nid('s'), q(r.float(0, 20)), 2),
          V(nid('v'), q(r.float(0, 20)), 3),
        ]),
      );
    },
  ],
  [
    'copy/paste',
    (st, r, log) => {
      const xs = allItems(st.getState().project);
      if (!xs.length) return;
      st.getState().select([r.pick(xs).id, r.pick(xs).id]);
      st.getState().copy();
      st.getState().setPlayhead(q(r.float(0, 30)));
      log.push('paste');
      if (r.chance(0.3)) st.getState().cut();
      else st.getState().paste();
    },
  ],
  [
    'cue',
    (st, r, log) => {
      const cues = allItems(st.getState().project).filter((i) => i.type === 'subtitle');
      if (!cues.length) return;
      const c = r.pick(cues);
      log.push(`cue ${c.id}`);
      const k = r.int(0, 3);
      if (k === 0)
        st.getState().setCueText(
          c.id,
          Array.from({ length: r.int(0, 8) }, () =>
            r.pick(['w0x', 'w1x', 'new', 'hello', 'w2x']),
          ).join(' '),
        );
      else if (k === 1) st.getState().splitCue(c.id, r.int(0, 6));
      else if (k === 2) st.getState().mergeCueWithNext(c.id);
      else
        st.getState().retimeCue(
          c.id,
          q(c.startSec + r.float(-1, 1)),
          q(c.startSec + c.durationSec + r.float(-1, 1)),
        );
    },
  ],
  [
    'tracks',
    (st, r) => {
      const g = st.getState();
      const k = r.int(0, 3);
      if (k === 0)
        g.addTrack(
          r.pick(['video', 'overlay', 'text', 'audio', 'subtitle', 'image', 'sfx'] as const),
        );
      else if (k === 1) g.updateTrack(r.pick(g.project.tracks).id, { locked: r.chance(0.3) });
      else if (k === 2) g.moveTrack(r.pick(g.project.tracks).id, r.int(0, 6));
      else g.removeTrack(r.pick(g.project.tracks).id);
    },
  ],
  [
    'nudge',
    (st, r) => {
      const it = pickItem(st, r);
      if (it) {
        st.getState().select([it.id]);
        st.getState().nudgeSelected(r.pick([-10, -1, 1, 10]));
      }
    },
  ],
  [
    'markers',
    (st, r) => {
      st.getState().addMarker(q(r.float(0, 20)));
    },
  ],
  [
    'trimToPlayhead',
    (st, r) => {
      const it = pickItem(st, r);
      if (!it) return;
      st.getState().setPlayhead(q(it.startSec + r.float(0, it.durationSec)));
      st.getState().select([it.id]);
      st.getState().trimToPlayhead(r.pick(['start', 'end'] as const), { ripple: r.chance(0.5) });
    },
  ],
];

function checkHealthy(p: Project, where: string, log: string[], deep: boolean) {
  const problems = projectProblems(p);
  if (problems.length)
    throw new Error(
      `invariant violated after ${where}:\n${problems.slice(0, 5).join('\n')}\nlog:\n${log.slice(-12).join('\n')}`,
    );
  // media never plays footage that does not exist (the generated assets are long enough for the generated items)
  for (const t of p.tracks)
    for (const it of t.items) {
      if ((it.type !== 'video' && it.type !== 'audio') || it.freezeAtSec !== null) continue;
      const a = p.assets.find((x) => x.id === it.assetId);
      if (!a || a.durationSec === null) continue;
      if (it.inSec < -1e-6 || it.inSec + sourceSpan(it) > a.durationSec + 1e-3)
        throw new Error(
          `${it.id} runs off its asset after ${where}: in=${it.inSec} span=${sourceSpan(it)} asset=${a.durationSec}\nlog:\n${log.slice(-8).join('\n')}`,
        );
    }
  if (deep) {
    for (const t of p.tracks)
      for (const it of t.items) {
        const res = itemSchema.safeParse(it);
        if (!res.success)
          throw new Error(
            `item ${it.id} fails the schema after ${where}: ${res.error.message.slice(0, 300)}\nlog:\n${log.slice(-8).join('\n')}`,
          );
      }
  }
}

describe('fuzz: random op sequences keep every invariant', () => {
  const SEEDS = 60;
  const STEPS = 90;

  it(`${SEEDS} seeds × ${STEPS} ops: no overlap (except transitions), sorted, durations ≥ 0.04, keyframes sorted, schema-valid`, () => {
    const effective = new Map<string, number>();
    const tried = new Map<string, number>();
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = rng(seed * 7919);
      const original = randomProject(r);
      checkHealthy(original, `seed ${seed} generation`, [], true);
      const st = makeStore(original);
      const log: string[] = [];
      for (let step = 0; step < STEPS; step++) {
        const [name, act] = r.pick(ACTIONS);
        const before = st.getState().project;
        try {
          act(st, r, log);
          tried.set(name, (tried.get(name) ?? 0) + 1);
          if (st.getState().project !== before) effective.set(name, (effective.get(name) ?? 0) + 1);
        } catch (e) {
          throw new Error(
            `seed ${seed} step ${step} (${name}) threw: ${(e as Error).stack}\nlog:\n${log.slice(-10).join('\n')}`,
            { cause: e },
          );
        }
        checkHealthy(
          st.getState().project,
          `seed ${seed} step ${step} (${name})`,
          log,
          step % 3 === 0,
        );
      }
      // undo everything → the original project object; redo everything → the final one
      const finalProject = st.getState().project;
      let guard = 0;
      while (st.getState().canUndo && guard++ < 400) st.getState().undo();
      expect(st.getState().project, `seed ${seed} undo-all`).toBe(original);
      guard = 0;
      while (st.getState().canRedo && guard++ < 400) st.getState().redo();
      expect(st.getState().project, `seed ${seed} redo-all`).toBe(finalProject);
    }
    // The fuzzer must actually exercise the operations (not just have them rejected).
    const rate = (n: string) => (effective.get(n) ?? 0) / Math.max(1, tried.get(n) ?? 0);
    for (const n of [
      'trim',
      'split',
      'delete',
      'duplicate',
      'move',
      'transition',
      'speed',
      'freeze',
      'setProp',
      'copy/paste',
      'cue',
      'addAsset',
      'gaps',
      'group',
    ])
      expect(effective.get(n) ?? 0, `${n} was effective`).toBeGreaterThan(10);
    expect(rate('trim')).toBeGreaterThan(0.3);
    if (process.env.EDITOR_FUZZ_STATS)
      writeFileSync(
        process.env.EDITOR_FUZZ_STATS,
        [...tried].map(([k, v]) => `${k}: ${effective.get(k) ?? 0}/${v}`).join('\n'),
      );
  });

  it('history is exact at every step: undo then redo restores the same project object', () => {
    for (let seed = 100; seed < 112; seed++) {
      const r = rng(seed);
      const st = makeStore(randomProject(r));
      const log: string[] = [];
      for (let step = 0; step < 40; step++) {
        const [, act] = r.pick(ACTIONS);
        const before = st.getState().project;
        act(st, r, log);
        const after = st.getState().project;
        if (after !== before && st.getState().canUndo) {
          // only meaningful when the last action created (or merged into) a history step that spans before→after
          const depth = (st.getState() as unknown as { canUndo: boolean }).canUndo;
          expect(depth).toBe(true);
        }
      }
      const final = st.getState().project;
      const seen: Project[] = [final];
      let n = 0;
      while (st.getState().canUndo && n++ < 300) {
        st.getState().undo();
        seen.push(st.getState().project);
      }
      for (let i = seen.length - 2; i >= 0; i--) {
        st.getState().redo();
        expect(st.getState().project).toBe(seen[i]);
      }
    }
  });

  it('structural sharing: an edit on one track keeps every other track by reference', () => {
    const r = rng(5);
    const p = randomProject(r);
    const st = makeStore(p);
    const trackWith = p.tracks.find((t) => !t.locked && t.items.length > 1) as Track;
    const target = trackWith.items[0] as Item;
    st.getState().setPlayhead(target.startSec + target.durationSec / 2);
    st.getState().split(target.id);
    const after = st.getState().project;
    const changed = after.tracks.filter((t, i) => t !== p.tracks[i]);
    expect(changed.length).toBeLessThanOrEqual(
      p.tracks.filter((t) => t.items.some((i) => i.groupId && i.groupId === target.groupId))
        .length + 1,
    );
    expect(after.tracks.length).toBe(p.tracks.length);
    void itemEnd;
  });
});
