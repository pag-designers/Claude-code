/**
 * Upload bookkeeping for the Brand Kit sections: one list of rows (working / done / error) shared by drag-and-drop
 * and "browse", fed by `brand:progress` events. Pure reducer, unit tested.
 */
import type { BrandAssetKind } from '@shared/brand';

export interface UploadRow {
  id: string;
  /** The IPC call this row belongs to. */
  callId: string;
  kind: BrandAssetKind;
  name: string;
  fraction: number | null;
  stage: string;
  state: 'working' | 'done' | 'error';
  message?: string;
}

export interface UploadState {
  rows: UploadRow[];
  /** Calls in flight, oldest first (progress events for unknown file names attach to the newest). */
  calls: { callId: string; kind: BrandAssetKind }[];
}

export const emptyUploads: UploadState = { rows: [], calls: [] };

export type UploadAction =
  | { type: 'start'; callId: string; kind: BrandAssetKind; names: string[] }
  | {
      type: 'progress';
      name: string;
      fraction: number | null;
      stage: string;
      done: boolean;
    }
  | {
      type: 'settle';
      callId: string;
      errors: { name: string; message: string }[];
    }
  | { type: 'reject'; kind: BrandAssetKind; errors: { name: string; message: string }[] }
  | { type: 'dismiss'; id: string };

let seq = 0;
const rid = () => `up${++seq}`;

export function uploadReducer(state: UploadState, a: UploadAction): UploadState {
  switch (a.type) {
    case 'start':
      return {
        calls: [...state.calls, { callId: a.callId, kind: a.kind }],
        rows: [
          ...state.rows,
          ...a.names.map<UploadRow>((name) => ({
            id: rid(),
            callId: a.callId,
            kind: a.kind,
            name,
            fraction: null,
            stage: 'Waiting',
            state: 'working',
          })),
        ],
      };
    case 'progress': {
      const idx = state.rows.findIndex((r) => r.name === a.name && r.state !== 'error');
      if (idx >= 0) {
        const rows = state.rows.slice();
        const cur = rows[idx]!;
        rows[idx] = {
          ...cur,
          fraction: a.fraction,
          stage: a.stage,
          state: a.done ? 'done' : 'working',
        };
        return { ...state, rows };
      }
      const call = state.calls[state.calls.length - 1];
      if (!call) return state; // another window's upload: the asset list refreshes on brand:changed
      return {
        ...state,
        rows: [
          ...state.rows,
          {
            id: rid(),
            callId: call.callId,
            kind: call.kind,
            name: a.name,
            fraction: a.fraction,
            stage: a.stage,
            state: a.done ? 'done' : 'working',
          },
        ],
      };
    }
    case 'settle': {
      const kind = state.calls.find((c) => c.callId === a.callId)?.kind;
      const rows = state.rows.filter((r) => r.callId !== a.callId);
      if (kind) {
        for (const e of a.errors)
          rows.push({
            id: rid(),
            callId: a.callId,
            kind,
            name: e.name,
            fraction: null,
            stage: '',
            state: 'error',
            message: e.message,
          });
      }
      return { calls: state.calls.filter((c) => c.callId !== a.callId), rows };
    }
    case 'reject':
      return {
        ...state,
        rows: [
          ...state.rows,
          ...a.errors.map<UploadRow>((e) => ({
            id: rid(),
            callId: 'rejected',
            kind: a.kind,
            name: e.name,
            fraction: null,
            stage: '',
            state: 'error',
            message: e.message,
          })),
        ],
      };
    case 'dismiss':
      return { ...state, rows: state.rows.filter((r) => r.id !== a.id) };
  }
}

export const rowsOfKind = (s: UploadState, kind: BrandAssetKind) =>
  s.rows.filter((r) => r.kind === kind);
