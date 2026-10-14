'use client';

import * as React from 'react';
import {
  ClipboardPaste,
  Copy,
  Eye,
  Flag,
  FoldHorizontal,
  Link2,
  Lock,
  Pencil,
  Plus,
  Scissors,
  SlidersHorizontal,
  Trash2,
  Unlink,
  Volume2,
  ListChecks,
  CopyPlus,
  ScissorsLineDashed,
} from 'lucide-react';
import type { ProjectMarker, Track, TrackKind } from '@shared/editor';
import { useEditorStore } from '@/lib/editor/core';
import type { MenuEntry } from './context-menu';
import { TRACK_KIND_LABEL, endOf } from './geometry';
import { useTimelineUi } from './timeline-ui';

const S = () => useEditorStore.getState();
const sep = (id: string): MenuEntry => ({ kind: 'separator', id });

export const ADD_TRACK_KINDS: TrackKind[] = [
  'video',
  'overlay',
  'image',
  'text',
  'subtitle',
  'audio',
  'sfx',
];

export function openInspectorRequest() {
  window.dispatchEvent(new CustomEvent('clipfern:editor-focus-inspector'));
}

export function addTrackEntries(prefix: string): MenuEntry[] {
  return ADD_TRACK_KINDS.map((k) => ({
    kind: 'item' as const,
    id: `${prefix}-${k}`,
    label: `Add ${TRACK_KIND_LABEL[k].toLowerCase()} track`,
    icon: <Plus />,
    onSelect: () => {
      S().addTrack(k);
    },
  }));
}

export function itemMenu(): MenuEntry[] {
  const s = S();
  const ids = s.selection.itemIds;
  const playhead = s.playheadSec;
  const crossing = s.project.tracks.some((t) =>
    t.items.some(
      (i) => ids.includes(i.id) && playhead > i.startSec + 1e-6 && playhead < endOf(i) - 1e-6,
    ),
  );
  const grouped = s.project.tracks.some((t) =>
    t.items.some((i) => ids.includes(i.id) && i.groupId),
  );
  return [
    {
      kind: 'item',
      id: 'split',
      label: 'Split at playhead',
      icon: <Scissors />,
      keys: ['S'],
      disabled: !crossing,
      onSelect: () => {
        S().split(null);
      },
    },
    {
      kind: 'item',
      id: 'duplicate',
      label: 'Duplicate',
      icon: <CopyPlus />,
      keys: ['mod', 'D'],
      onSelect: () => {
        S().duplicateItems(ids);
      },
    },
    sep('s1'),
    {
      kind: 'item',
      id: 'copy',
      label: 'Copy',
      icon: <Copy />,
      keys: ['mod', 'C'],
      onSelect: () => S().copy(),
    },
    {
      kind: 'item',
      id: 'cut',
      label: 'Cut',
      icon: <Scissors />,
      keys: ['mod', 'X'],
      onSelect: () => S().cut(),
    },
    {
      kind: 'item',
      id: 'paste',
      label: 'Paste',
      icon: <ClipboardPaste />,
      keys: ['mod', 'V'],
      disabled: !s.clipboard,
      onSelect: () => {
        S().paste();
      },
    },
    sep('s2'),
    ids.length > 1
      ? {
          kind: 'item',
          id: 'group',
          label: 'Group',
          icon: <Link2 />,
          keys: ['mod', 'G'],
          onSelect: () => S().group(ids),
        }
      : {
          kind: 'item',
          id: 'group',
          label: 'Group',
          icon: <Link2 />,
          disabled: true,
          onSelect: () => {},
        },
    {
      kind: 'item',
      id: 'ungroup',
      label: 'Ungroup',
      icon: <Unlink />,
      keys: ['mod', 'shift', 'G'],
      disabled: !grouped,
      onSelect: () => S().ungroup(ids),
    },
    {
      kind: 'item',
      id: 'inspect',
      label: 'Open in inspector',
      icon: <SlidersHorizontal />,
      keys: ['enter'],
      onSelect: openInspectorRequest,
    },
    sep('s3'),
    {
      kind: 'item',
      id: 'ripple-delete',
      label: 'Ripple delete',
      icon: <FoldHorizontal />,
      keys: ['shift', 'Del'],
      onSelect: () => S().deleteItems(ids, { ripple: true }),
    },
    {
      kind: 'item',
      id: 'delete',
      label: 'Delete',
      icon: <Trash2 />,
      keys: ['Del'],
      danger: true,
      onSelect: () => S().deleteItems(ids),
    },
  ];
}

export function laneMenu(trackId: string | null, sec: number): MenuEntry[] {
  const s = S();
  return [
    {
      kind: 'item',
      id: 'paste',
      label: 'Paste',
      icon: <ClipboardPaste />,
      keys: ['mod', 'V'],
      disabled: !s.clipboard,
      onSelect: () => {
        if (trackId) s.selectTrack(trackId);
        S().paste();
      },
    },
    {
      kind: 'item',
      id: 'marker',
      label: 'Add marker here',
      icon: <Flag />,
      keys: ['M'],
      onSelect: () => {
        S().addMarker(sec);
      },
    },
    ...(trackId
      ? ([
          {
            kind: 'item',
            id: 'gaps',
            label: 'Delete gaps on this track',
            icon: <ScissorsLineDashed />,
            onSelect: () => S().deleteGaps(trackId),
          },
          {
            kind: 'item',
            id: 'select-all',
            label: 'Select all on this track',
            icon: <ListChecks />,
            onSelect: () => S().selectAll(trackId),
          },
        ] satisfies MenuEntry[])
      : []),
    sep('s1'),
    ...addTrackEntries('lane-add'),
  ];
}

export function trackMenu(track: Track): MenuEntry[] {
  const hasAudio = track.kind !== 'text' && track.kind !== 'subtitle' && track.kind !== 'image';
  return [
    {
      kind: 'item',
      id: 'rename',
      label: 'Rename track',
      icon: <Pencil />,
      onSelect: () => useTimelineUi.getState().set({ editingTrackId: track.id }),
    },
    {
      kind: 'item',
      id: 'select-all',
      label: 'Select all clips on track',
      icon: <ListChecks />,
      onSelect: () => S().selectAll(track.id),
    },
    {
      kind: 'item',
      id: 'gaps',
      label: 'Delete gaps',
      icon: <ScissorsLineDashed />,
      onSelect: () => S().deleteGaps(track.id),
    },
    sep('s1'),
    {
      kind: 'item',
      id: 'lock',
      label: track.locked ? 'Unlock track' : 'Lock track',
      icon: <Lock />,
      onSelect: () => S().updateTrack(track.id, { locked: !track.locked }),
    },
    ...(hasAudio
      ? ([
          {
            kind: 'item',
            id: 'mute',
            label: track.muted ? 'Unmute track' : 'Mute track',
            icon: <Volume2 />,
            onSelect: () => S().updateTrack(track.id, { muted: !track.muted }),
          },
        ] satisfies MenuEntry[])
      : []),
    {
      kind: 'item',
      id: 'hide',
      label: track.hidden ? 'Show track' : 'Hide track',
      icon: <Eye />,
      onSelect: () => S().updateTrack(track.id, { hidden: !track.hidden }),
    },
    sep('s2'),
    ...addTrackEntries('hdr-add'),
    sep('s3'),
    {
      kind: 'item',
      id: 'remove',
      label: 'Delete track',
      icon: <Trash2 />,
      danger: true,
      onSelect: () => S().removeTrack(track.id),
    },
  ];
}

export function markerMenu(marker: ProjectMarker): MenuEntry[] {
  return [
    {
      kind: 'item',
      id: 'goto',
      label: 'Go to marker',
      icon: <Flag />,
      onSelect: () => S().setPlayhead(marker.atSec),
    },
    {
      kind: 'item',
      id: 'rename',
      label: 'Rename marker',
      icon: <Pencil />,
      onSelect: () => useTimelineUi.getState().set({ editingMarkerId: marker.id }),
    },
    sep('s1'),
    {
      kind: 'item',
      id: 'delete',
      label: 'Delete marker',
      icon: <Trash2 />,
      danger: true,
      onSelect: () => S().removeMarker(marker.id),
    },
  ];
}
