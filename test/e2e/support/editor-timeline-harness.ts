/**
 * Helpers for the editor shell + timeline specs: open `/editor/?id=…` against the contract-validated bridge stub with
 * the e2e store hook enabled, read store state, and drive the timeline with real mouse / keyboard input.
 */
import type { Page } from '@playwright/test';
import type { Item, Project } from '../../../shared/editor';
import type { OpenOptions, Harness, Session } from './harness';
import type { StubState } from './clipfern-stub';
import { seedTimeline } from './editor-stub';

/** The slice of the editor store the tests read / drive (the real store has more). */
export interface StoreView {
  projectId: string | null;
  name: string;
  rev: number;
  project: Project;
  saveState: string;
  playheadSec: number;
  playing: boolean;
  pxPerSec: number;
  scrollSec: number;
  snapEnabled: boolean;
  rippleEnabled: boolean;
  selection: { itemIds: string[]; trackId: string | null; keyframe: unknown };
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  safeArea: string | null;
  showGrid: boolean;
  loop: boolean;
  rate: number;
  [k: string]: unknown;
}

declare global {
  interface Window {
    __CLIPFERN_E2E__?: boolean;
    __clipfernEditorStore?: {
      getState(): Record<string, unknown>;
      setState(p: Record<string, unknown>): void;
    };
  }
}

export interface EditorSession extends Session {
  /** Snapshot of the store (JSON round trip, so functions are dropped). */
  store(): Promise<StoreView>;
  /** Calls a store action. */
  act(name: string, ...args: unknown[]): Promise<unknown>;
  item(id: string): Promise<Item | null>;
}

export async function openEditor(
  h: Harness,
  open: (route: string, opts?: OpenOptions) => Promise<Session>,
  projectId = 'tl-demo',
  opts: OpenOptions & {
    seed?: boolean;
    prepareState?: (s: StubState) => void;
    expect?: 'ready' | 'error';
  } = {},
): Promise<EditorSession> {
  const { seed = true, prepareState, expect = 'ready', ...rest } = opts;
  const s = await open('/settings/shortcuts/', {
    scenario: 'library',
    settle: 0,
    ...rest,
    prepare: (st) => {
      if (seed) seedTimeline(st);
      prepareState?.(st);
      rest.prepare?.(st);
    },
  });
  await s.page.addInitScript(() => {
    window.__CLIPFERN_E2E__ = true;
  });
  await s.page.goto(`${h.base}/editor/?id=${projectId}`);
  if (expect === 'error') {
    await s.page.getByTestId('editor-error').waitFor({ timeout: 20_000 });
    return s as EditorSession;
  }
  await s.page.getByTestId('editor-workspace').waitFor({ timeout: 20_000 });
  await s.page.getByTestId('timeline').waitFor();
  // the store hook is set right after the project is loaded
  await s.page.waitForFunction(() => !!window.__clipfernEditorStore?.getState().projectId);
  const ed = s as EditorSession;
  ed.store = () =>
    s.page.evaluate(
      () => JSON.parse(JSON.stringify(window.__clipfernEditorStore!.getState())) as never,
    );
  ed.act = (name, ...args) =>
    s.page.evaluate(
      ([n, a]) => {
        const st = window.__clipfernEditorStore!.getState() as Record<string, unknown>;
        const fn = st[n as string] as (...x: unknown[]) => unknown;
        return fn(...(a as unknown[])) as never;
      },
      [name, args] as const,
    );
  ed.item = async (id) => {
    const st = await ed.store();
    for (const t of st.project.tracks) {
      const it = t.items.find((i) => i.id === id);
      if (it) return it;
    }
    return null;
  };
  return ed;
}

/** Page-pixel position of a time on a track row (centre of the row vertically). */
export async function laneXY(
  page: Page,
  trackId: string,
  sec: number,
  yFrac = 0.5,
): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ([id, t, f]) => {
      const scroller = document.querySelector('[data-testid="timeline-scroller"]') as HTMLElement;
      const row = document.querySelector(
        `[data-testid="track-row"][data-track-id="${id}"]`,
      ) as HTMLElement;
      const st = window.__clipfernEditorStore!.getState() as { pxPerSec: number };
      const r = scroller.getBoundingClientRect();
      const rr = row.getBoundingClientRect();
      // lane origin = scroller left + header width (200) - scrollLeft
      return {
        x: r.left + 200 - scroller.scrollLeft + (t as number) * st.pxPerSec,
        y: rr.top + rr.height * (f as number),
      };
    },
    [trackId, sec, yFrac] as const,
  );
}

export const itemBox = async (page: Page, itemId: string) => {
  const box = await page
    .locator(`[data-testid="timeline"] [data-item-id="${itemId}"][role="option"]`)
    .boundingBox();
  if (!box) throw new Error(`item ${itemId} is not rendered`);
  return box;
};
