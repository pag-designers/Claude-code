import { projectSchema, type Project } from '../../../../shared/editor';

/** Fixture project for the inspector lab + its Playwright spec (ids are stable so tests can select by id). */
export const LAB_IDS = {
  v1: 'v1',
  v2: 'v2',
  c1: 'c1',
  c2: 'c2',
  c3: 'c3',
  t1: 't1',
  m1: 'm1',
  s1: 's1',
  i1: 'i1',
  trackVideo: 'tr_v',
  trackSub: 'tr_sub',
  trackText: 'tr_text',
  trackMusic: 'tr_music',
  trackOverlay: 'tr_ov',
  trackImage: 'tr_img',
} as const;

const w = (text: string, s: number, e: number) => ({ w: text, s, e });

export function buildLabProject(): Project {
  return projectSchema.parse({
    canvas: { aspect: '9:16', width: 1080, height: 1920, fps: 30, background: '#000000' },
    assets: [
      {
        id: 'a_video',
        kind: 'video',
        name: 'interview.mp4',
        source: { kind: 'upload', key: 'k/interview.mp4', fileName: 'interview.mp4' },
        durationSec: 120,
        width: 1920,
        height: 1080,
        fps: 30,
        hasAudio: true,
      },
      {
        id: 'a_video2',
        kind: 'video',
        name: 'broll.mp4',
        source: { kind: 'upload', key: 'k/broll.mp4', fileName: 'broll.mp4' },
        durationSec: 60,
        width: 1920,
        height: 1080,
        fps: 30,
        hasAudio: true,
      },
      {
        id: 'a_music',
        kind: 'audio',
        name: 'lofi-beat.mp3',
        source: { kind: 'upload', key: 'k/lofi.mp3', fileName: 'lofi.mp3' },
        durationSec: 90,
        hasAudio: true,
      },
      {
        id: 'a_img',
        kind: 'image',
        name: 'logo.png',
        source: { kind: 'upload', key: 'k/logo.png', fileName: 'logo.png' },
        width: 800,
        height: 800,
      },
    ],
    tracks: [
      {
        id: 'tr_v',
        kind: 'video',
        name: 'Video',
        speech: true,
        items: [
          {
            type: 'video',
            id: 'v1',
            assetId: 'a_video',
            startSec: 0,
            durationSec: 8,
            inSec: 10,
            name: 'Interview',
          },
          {
            type: 'video',
            id: 'v2',
            assetId: 'a_video2',
            startSec: 8,
            durationSec: 6,
            inSec: 40,
            name: 'B-roll',
          },
        ],
      },
      {
        id: 'tr_ov',
        kind: 'overlay',
        name: 'Overlay',
        items: [
          {
            type: 'shape',
            id: 's1',
            shape: 'rect',
            startSec: 2,
            durationSec: 5,
            width: 400,
            height: 40,
          },
        ],
      },
      {
        id: 'tr_img',
        kind: 'image',
        name: 'Images',
        items: [{ type: 'image', id: 'i1', assetId: 'a_img', startSec: 0, durationSec: 4 }],
      },
      {
        id: 'tr_text',
        kind: 'text',
        name: 'Text',
        items: [{ type: 'text', id: 't1', text: 'Hello world', startSec: 1, durationSec: 4 }],
      },
      {
        id: 'tr_sub',
        kind: 'subtitle',
        name: 'Captions',
        items: [
          {
            type: 'subtitle',
            id: 'c1',
            startSec: 1,
            durationSec: 2.4,
            words: [
              w('Welcome', 0, 0.5),
              w('back', 0.5, 0.9),
              w('to', 0.9, 1.1),
              w('the', 1.1, 1.3),
              w('show', 1.3, 2.4),
            ],
          },
          {
            type: 'subtitle',
            id: 'c2',
            startSec: 4,
            durationSec: 2,
            words: [w('Let', 0, 0.4), w('us', 0.4, 0.7), w('dive', 0.7, 1.2), w('in', 1.2, 2)],
          },
          {
            type: 'subtitle',
            id: 'c3',
            startSec: 6.5,
            durationSec: 1.5,
            words: [w('Ready', 0, 0.7), w('go', 0.7, 1.5)],
          },
        ],
      },
      {
        id: 'tr_music',
        kind: 'audio',
        name: 'Music',
        items: [
          {
            type: 'audio',
            id: 'm1',
            assetId: 'a_music',
            startSec: 0,
            durationSec: 20,
            inSec: 0,
            name: 'Lo-fi beat',
          },
        ],
      },
    ],
  });
}
