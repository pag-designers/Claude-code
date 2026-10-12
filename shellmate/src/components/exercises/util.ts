import { useEffect, useRef } from 'react';
import type { DependencyList } from 'react';
import type { GradeResult } from '../../types';

/** True when a key event originates from a text-entry element (so global shortcuts should be ignored). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * Report readiness + a grader to the lesson player whenever `deps` change.
 * `onReady` is read through a ref so an unstable callback from the parent can't cause a render loop.
 */
export function useReportReady(
  onReady: (ready: boolean, grade?: () => GradeResult) => void,
  ready: boolean,
  grade: () => GradeResult,
  deps: DependencyList,
) {
  const onReadyRef = useRef(onReady);
  const gradeRef = useRef(grade);
  useEffect(() => {
    onReadyRef.current = onReady;
    gradeRef.current = grade;
  });
  useEffect(() => {
    onReadyRef.current(ready, () => gradeRef.current());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, ...deps]);
}

export const SHAKE = { x: [0, -8, 8, -6, 6, 0] };
export const BOUNCE = { scale: [1, 1.06, 1] };
