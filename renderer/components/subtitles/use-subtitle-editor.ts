'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { Cue, SubtitleEdits } from '@shared/cp2';
import { invoke, ipcKey, useIpcQuery } from '@/lib/ipc';
import { useTranscript } from '@/lib/library';
import {
  applyCueText,
  deleteCue,
  emptyHistory,
  mergeWithNext,
  NUDGE_STEP,
  pushHistory,
  redoHistory,
  setCueStart,
  shiftCue,
  splitCue,
  undoHistory,
  type History,
  type OpResult,
  type SubState,
  type TWord,
} from './edits';

export const SAVE_DEBOUNCE_MS = 700;

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

interface SubtitlesData {
  cues: Cue[];
  edits: SubtitleEdits;
  language: string;
  outdatedClips: number;
}

/**
 * Subtitle editor state for one video: optimistic edits, 50-level undo/redo and a debounced, serialised autosave.
 *
 * - Every operation updates the cue list immediately; `subtitles:save` then returns the authoritative cues. They are
 *   adopted only when nothing newer happened meanwhile, so typing never fights the server.
 * - Unsaved edits are flushed when the tab unmounts, and the query cache is updated after every save so reopening the
 *   tab shows the latest cues instead of the first fetch.
 */
export function useSubtitleEditor(videoId: string) {
  const qc = useQueryClient();
  const query = useIpcQuery(
    'subtitles:get',
    { videoId },
    { staleTime: Infinity, gcTime: 30 * 60_000, refetchOnWindowFocus: false, retry: 1 },
  );
  const transcript = useTranscript(videoId);
  const words = React.useMemo<TWord[] | null>(
    () => transcript.data?.words.map((w) => ({ w: w.w, s: w.s, e: w.e })) ?? null,
    [transcript.data],
  );
  const wordsRef = React.useRef(words);
  React.useEffect(() => {
    wordsRef.current = words;
  });

  const [state, setStateRaw] = React.useState<SubState | null>(null);
  // mirrors `state` for event handlers and timers (state is the source of truth; see the sync effect below)
  const stateRef = React.useRef<SubState | null>(null);
  const setState = React.useCallback((s: SubState | null) => {
    stateRef.current = s;
    setStateRaw(s);
  }, []);
  React.useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const [history, setHistory] = React.useState<History<SubState>>(emptyHistory);
  const historyRef = React.useRef(history);
  const [status, setStatus] = React.useState<SaveStatus>('idle');
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [outdated, setOutdated] = React.useState(0);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);

  // adopt the first fetch (later server answers arrive through `flush`, which updates the state directly)
  const [adopted, setAdopted] = React.useState<SubtitlesData | null>(null);
  if (query.data && adopted === null) {
    setAdopted(query.data);
    setStateRaw({ cues: query.data.cues, edits: query.data.edits });
    setOutdated(query.data.outdatedClips);
  }
  const language = query.data?.language ?? '';
  const dataRef = React.useRef<SubtitlesData | null>(null);
  const serverRev = React.useRef(0);
  React.useEffect(() => {
    if (!adopted) return;
    dataRef.current = adopted;
    serverRev.current = adopted.edits.rev;
  }, [adopted]);

  /* ---- saving ---- */
  const version = React.useRef(0); // bumped on every local change
  const savedVersion = React.useRef(0);
  const inflight = React.useRef<Promise<boolean> | null>(null);
  const again = React.useRef(false);
  const timer = React.useRef<number | null>(null);
  const alive = React.useRef(true);
  const flushRef = React.useRef<() => Promise<boolean>>(async () => true);

  const flush = React.useCallback(async (): Promise<boolean> => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (inflight.current) {
      again.current = true;
      return inflight.current;
    }
    const cur = stateRef.current;
    if (!cur || version.current === savedVersion.current) return true;
    const sentVersion = version.current;
    const run = (async () => {
      if (alive.current) {
        setStatus('saving');
        setSaveError(null);
      }
      try {
        const res = await invoke('subtitles:save', {
          videoId,
          edits: { ...cur.edits, rev: serverRev.current },
        });
        serverRev.current = res.edits.rev;
        savedVersion.current = sentVersion;
        const data: SubtitlesData = {
          cues: res.cues,
          edits: res.edits,
          language: dataRef.current?.language ?? language,
          outdatedClips: res.outdatedClips,
        };
        dataRef.current = data;
        qc.setQueryData(ipcKey('subtitles:get', { videoId }), data);
        // the video's subtitleRev moved: clips list refreshes through clips:updated / videos:updated events
        if (alive.current) {
          setOutdated(res.outdatedClips);
          if (version.current === sentVersion) {
            // nothing newer: take the authoritative cues
            setState({ cues: res.cues, edits: res.edits });
            setStatus('saved');
            setSavedAt(Date.now());
          } else {
            const now = stateRef.current;
            if (now) stateRef.current = { ...now, edits: { ...now.edits, rev: res.edits.rev } };
          }
        }
        return true;
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Could not save the subtitles.';
        if (alive.current) {
          setStatus('error');
          setSaveError(message);
          toast.error('Subtitles were not saved', {
            description: message,
            action: { label: 'Retry', onClick: () => void flushRef.current() },
            id: 'subtitles-save-error',
          });
        }
        return false;
      } finally {
        inflight.current = null;
        if (again.current) {
          again.current = false;
          if (version.current !== savedVersion.current) void flushRef.current();
        }
      }
    })();
    inflight.current = run;
    return run;
  }, [videoId, qc, language, setState]);
  React.useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  const scheduleSave = React.useCallback(() => {
    version.current += 1;
    setStatus('dirty');
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flushRef.current(), SAVE_DEBOUNCE_MS);
  }, []);

  // never lose edits when the tab (or page) is left
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current !== null) window.clearTimeout(timer.current);
      if (version.current !== savedVersion.current) void flushRef.current();
    };
  }, []);

  /* ---- operations ---- */
  const commit = React.useCallback(
    (op: (s: SubState, w: TWord[]) => OpResult | null): boolean => {
      const cur = stateRef.current;
      const w = wordsRef.current;
      if (!cur || !w) return false;
      const res = op(cur, w);
      if (!res || res.state === cur) {
        if (res?.warning) toast.info(res.warning);
        return false;
      }
      if (res.warning) toast.info(res.warning);
      const h = pushHistory(historyRef.current, cur);
      historyRef.current = h;
      setHistory(h);
      setState(res.state);
      scheduleSave();
      return true;
    },
    [scheduleSave, setState],
  );

  const ops = React.useMemo(
    () => ({
      setText: (cueId: number, text: string) => commit((s, w) => applyCueText(s, w, cueId, text)),
      split: (cueId: number, keep: number) => commit((s, w) => splitCue(s, w, cueId, keep)),
      /** Applies a text edit and splits it in one undo step. */
      textAndSplit: (cueId: number, text: string, keep: number) =>
        commit((s, w) => {
          const a = applyCueText(s, w, cueId, text);
          const b = splitCue(a.state, w, cueId, keep);
          return { state: b.state, warning: b.warning ?? a.warning };
        }),
      merge: (cueId: number) => commit((s, w) => mergeWithNext(s, w, cueId)),
      nudge: (cueId: number, delta: number) => commit((s, w) => shiftCue(s, w, cueId, delta)),
      setStart: (cueId: number, start: number) => commit((s, w) => setCueStart(s, w, cueId, start)),
      remove: (cueId: number) => commit((s) => deleteCue(s, cueId)),
    }),
    [commit],
  );

  const undo = React.useCallback(() => {
    const cur = stateRef.current;
    if (!cur) return;
    const r = undoHistory(historyRef.current, cur);
    if (!r) return;
    historyRef.current = r.history;
    setHistory(r.history);
    setState(r.value);
    scheduleSave();
  }, [scheduleSave, setState]);
  const redo = React.useCallback(() => {
    const cur = stateRef.current;
    if (!cur) return;
    const r = redoHistory(historyRef.current, cur);
    if (!r) return;
    historyRef.current = r.history;
    setHistory(r.history);
    setState(r.value);
    scheduleSave();
  }, [scheduleSave, setState]);

  return {
    query,
    transcriptQuery: transcript,
    ready: !!state && !!words,
    cues: state?.cues ?? EMPTY_CUES,
    edits: state?.edits ?? null,
    language,
    outdated,
    status,
    saveError,
    savedAt,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    undo,
    redo,
    flush,
    retry: () => void flush(),
    ...ops,
    NUDGE_STEP,
  };
}

const EMPTY_CUES: Cue[] = [];
