import { describe, expect, it } from 'vitest';
import {
  emptyUploads,
  rowsOfKind,
  uploadReducer,
  type UploadAction,
  type UploadState,
} from '../../renderer/lib/brand/uploads';

const run = (actions: UploadAction[], from: UploadState = emptyUploads) =>
  actions.reduce(uploadReducer, from);

describe('upload reducer', () => {
  it('drops start as working rows and progress updates them by file name', () => {
    const s = run([
      { type: 'start', callId: 'c1', kind: 'logo', names: ['a.png', 'b.png'] },
      { type: 'progress', name: 'a.png', fraction: 0.4, stage: 'upload', done: false },
    ]);
    expect(s.rows.map((r) => [r.name, r.fraction, r.state])).toEqual([
      ['a.png', 0.4, 'working'],
      ['b.png', null, 'working'],
    ]);
    const done = uploadReducer(s, {
      type: 'progress',
      name: 'a.png',
      fraction: 1,
      stage: 'done',
      done: true,
    });
    expect(done.rows[0]!.state).toBe('done');
  });

  it('browse has no names up front: progress events create rows under the newest call', () => {
    const s = run([
      { type: 'start', callId: 'c1', kind: 'audio', names: [] },
      { type: 'progress', name: 'bed.mp3', fraction: 0.2, stage: 'loudness', done: false },
    ]);
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]).toMatchObject({ kind: 'audio', callId: 'c1', name: 'bed.mp3' });
  });

  it('progress with no call in flight (another window) is ignored', () => {
    const s = uploadReducer(emptyUploads, {
      type: 'progress',
      name: 'x.png',
      fraction: 0.5,
      stage: 'upload',
      done: false,
    });
    expect(s).toBe(emptyUploads);
  });

  it('settle removes the call rows and leaves one error row per failed file', () => {
    const s = run([
      { type: 'start', callId: 'c1', kind: 'image', names: ['ok.png', 'bad.png'] },
      {
        type: 'settle',
        callId: 'c1',
        errors: [{ name: 'bad.png', message: 'Corrupted' }],
      },
    ]);
    expect(s.calls).toEqual([]);
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]).toMatchObject({ name: 'bad.png', state: 'error', message: 'Corrupted' });
  });

  it('reject adds error rows immediately and dismiss removes one', () => {
    let s = uploadReducer(emptyUploads, {
      type: 'reject',
      kind: 'font',
      errors: [{ name: 'a.txt', message: 'no' }],
    });
    expect(rowsOfKind(s, 'font')).toHaveLength(1);
    expect(rowsOfKind(s, 'logo')).toHaveLength(0);
    s = uploadReducer(s, { type: 'dismiss', id: s.rows[0]!.id });
    expect(s.rows).toHaveLength(0);
  });

  it('a progress event does not revive an error row of the same name', () => {
    let s = run([{ type: 'reject', kind: 'logo', errors: [{ name: 'a.png', message: 'x' }] }]);
    s = run(
      [
        { type: 'start', callId: 'c2', kind: 'logo', names: [] },
        { type: 'progress', name: 'a.png', fraction: 0.1, stage: 'probe', done: false },
      ],
      s,
    );
    expect(s.rows.filter((r) => r.name === 'a.png').map((r) => r.state)).toEqual([
      'error',
      'working',
    ]);
  });
});
