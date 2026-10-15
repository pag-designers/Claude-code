/**
 * TEST-ONLY stand-in for main's CP4 "apply a Brand Kit to clips" behaviour, layered over the CP1/CP2 stubs WITHOUT
 * editing them: it wraps `stubB.handle` (which the main stub consults for every channel it does not know), so
 * `brand:list`, `brand:get`, `brand:defaultKit` and `brand:apply` are answered here. Every request and response still
 * goes through the real zod contract (installClipfernStub / cp2b-harness validate them), so this cannot drift.
 *
 * Renders are driven by the test (`lib.step`, `lib.finish`) so progress assertions are deterministic; `lib.auto(ms)`
 * runs them on a timer for screenshots.
 */
import { encodeIpcError, invokeContract } from '../../../shared/ipc';
import {
  brandKitSchema,
  brandKitSummarySchema,
  defaultBrandSpec,
  resolveBrandKitId,
} from '../../../shared/brand';
import type { ClipView } from '../../../shared/pipeline';
import type { StubState } from './clipfern-stub';
import { stubB } from './cp2-stub-b';

export interface StubKit {
  id: string;
  name: string;
  isDefault: boolean;
  rev: number;
  swatches: string[];
}

export interface BrandLib {
  kits: StubKit[];
  /** Applies that reached main, in order (payloads already contract-validated). */
  applies: { kitId: string | null; clipIds?: string[]; videoId?: string }[];
  /** The next `times` brand:apply calls fail with this message. */
  failApply: {
    message: string;
    times: number;
    code?: 'NOT_FOUND' | 'FAILED' | 'UNAVAILABLE';
  } | null;
  autoMs: number | null;
  /** Moves a rendering clip to `progress` (status 'rendering'). */
  step: (clipId: string, progress: number) => Promise<void>;
  /** Finishes a clip's render with the kit it resolves to now (brandApplied = kit id + current rev). */
  finish: (clipId: string) => Promise<void>;
  /** Bumps a kit's revision (an edit on the Brand Kit page) and announces `brand:changed`. */
  editKit: (id: string) => Promise<void>;
  auto: (ms: number | null) => void;
  clip: (id: string) => ClipView;
}

const libs = new WeakMap<StubState, BrandLib>();
let patched = false;

const KINDS = ['logo', 'image', 'video', 'audio', 'font'] as const;
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

export const KIT_ACME: StubKit = {
  id: 'kit-acme',
  name: 'Acme Studio',
  isDefault: true,
  rev: 3,
  swatches: ['#7C5CFF', '#101114', '#FFD166'],
};
export const KIT_NEON: StubKit = {
  id: 'kit-neon',
  name: 'Neon Nights',
  isDefault: false,
  rev: 1,
  swatches: ['#00E5FF', '#FF2E93'],
};

function notFound(what: string): Error {
  return new Error(encodeIpcError('NOT_FOUND', `${what} not found.`));
}

/** Installs the brand layer into a session (call from the harness `prepare` hook). */
export function installBrandLib(
  state: StubState,
  kits: StubKit[] = [KIT_ACME, KIT_NEON],
): BrandLib {
  const lib: BrandLib = {
    kits: kits.map((k) => ({ ...k })),
    applies: [],
    failApply: null,
    autoMs: null,
    clip(id) {
      const c = state.clips.find((x) => x.id === id);
      if (!c) throw new Error(`no clip ${id}`);
      return c;
    },
    async step(clipId, progress) {
      const c = lib.clip(clipId);
      Object.assign(c, { status: 'rendering', renderProgress: progress });
      await state.emit?.('clips:updated', { ...c });
    },
    async finish(clipId) {
      const c = lib.clip(clipId);
      const kitId = effectiveKitIdOf(state, lib, c);
      const kit = lib.kits.find((k) => k.id === kitId);
      Object.assign(c, {
        status: 'rendered',
        renderProgress: null,
        hasRender: true,
        brandApplied: kit ? { kitId: kit.id, rev: kit.rev } : null,
      });
      await state.emit?.('clips:updated', { ...c });
    },
    async editKit(id) {
      const k = lib.kits.find((x) => x.id === id);
      if (!k) throw new Error(`no kit ${id}`);
      k.rev += 1;
      await state.emit?.('brand:changed', { kitId: id });
    },
    auto(ms) {
      lib.autoMs = ms;
    },
  };
  libs.set(state, lib);
  patch();
  return lib;
}

export function brandLib(state: StubState): BrandLib {
  const l = libs.get(state);
  if (!l) throw new Error('installBrandLib was not called for this session');
  return l;
}

function defaultId(lib: BrandLib): string | null {
  return lib.kits.find((k) => k.isDefault)?.id ?? null;
}

function effectiveKitIdOf(state: StubState, lib: BrandLib, c: ClipView): string | null {
  const run = state.videos.find((v) => v.id === c.videoId)?.options.brandKitId;
  const id = resolveBrandKitId(c.brandKitId, run, defaultId(lib));
  return id && lib.kits.some((k) => k.id === id) ? id : null;
}

function patch() {
  if (patched) return;
  patched = true;
  const orig = stubB.handle.bind(stubB);
  stubB.handle = async (state, channel, payload) => {
    const lib = libs.get(state as StubState);
    if (!lib || !channel.startsWith('brand:')) return orig(state, channel, payload);
    return handleBrand(state as StubState, lib, channel, payload);
  };
}

async function handleBrand(
  state: StubState,
  lib: BrandLib,
  channel: string,
  payload: unknown,
): Promise<{ value: unknown } | null> {
  const p = (payload ?? {}) as Record<string, unknown>;
  switch (channel) {
    case 'brand:list':
      return {
        value: {
          items: lib.kits.map((k) =>
            brandKitSummarySchema.parse({
              id: k.id,
              name: k.name,
              isDefault: k.isDefault,
              updatedAt: NOW,
              counts: Object.fromEntries(KINDS.map((x) => [x, 0])),
              swatches: k.swatches,
              logoThumbUrl: null,
            }),
          ),
        },
      };
    case 'brand:get': {
      const k = lib.kits.find((x) => x.id === p.id);
      if (!k) throw notFound('Brand Kit');
      return {
        value: {
          kit: brandKitSchema.parse({
            id: k.id,
            name: k.name,
            isDefault: k.isDefault,
            spec: defaultBrandSpec(),
            rev: k.rev,
            createdAt: NOW,
            updatedAt: NOW,
          }),
          assets: [],
        },
      };
    }
    case 'brand:defaultKit':
      return { value: { id: defaultId(lib) } };
    case 'brand:apply':
      return { value: await apply(state, lib, p) };
    default:
      return null;
  }
}

async function apply(state: StubState, lib: BrandLib, p: Record<string, unknown>) {
  const input = invokeContract['brand:apply'].input.parse(p);
  lib.applies.push({
    kitId: input.kitId,
    ...(input.clipIds ? { clipIds: input.clipIds } : {}),
    ...(input.videoId ? { videoId: input.videoId } : {}),
  });
  if (lib.failApply && lib.failApply.times > 0) {
    lib.failApply.times -= 1;
    throw new Error(encodeIpcError(lib.failApply.code ?? 'FAILED', lib.failApply.message));
  }
  if (input.kitId && input.kitId !== 'none' && !lib.kits.some((k) => k.id === input.kitId))
    throw notFound('Brand Kit');

  const targets = state.clips.filter((c) =>
    input.clipIds ? input.clipIds.includes(c.id) : c.videoId === input.videoId,
  );
  let queued = 0;
  let skipped = 0;
  for (const c of targets) {
    if (c.status === 'queued' || c.status === 'rendering' || c.status === 'candidate') {
      skipped += 1;
      continue;
    }
    Object.assign(c, {
      brandKitId: input.kitId,
      status: 'queued',
      renderProgress: null,
      error: null,
    });
    queued += 1;
    await state.emit?.('clips:updated', { ...c });
    if (lib.autoMs !== null) void autoRender(state, lib, c.id, lib.autoMs);
  }
  return { queued, skipped };
}

async function autoRender(state: StubState, lib: BrandLib, id: string, ms: number) {
  const sleep = (n: number) => new Promise((r) => setTimeout(r, n));
  try {
    await sleep(ms);
    await lib.step(id, 0.3);
    await sleep(ms);
    await lib.step(id, 0.7);
    await sleep(ms);
    await lib.finish(id);
  } catch {
    /* page closed mid-render */
  }
  void state;
}
