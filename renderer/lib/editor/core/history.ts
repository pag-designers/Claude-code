/**
 * Undo / redo history (command pattern, 200 levels).
 *
 * REPRESENTATION: a command holds the whole-Project snapshot before and after the edit. Because every pure op
 * (ops/*) returns a new Project that STRUCTURALLY SHARES every track / item it did not touch (copy-on-write
 * `Draft`), a snapshot costs only the touched track's item array (+ the changed items), not a deep copy: 200
 * levels on a 3,000-item project is ~200 × one array of pointers, and apply / undo are O(1) reference swaps
 * (no patch replay, no inverse computation → no way for undo to drift from apply). Selection is captured too, so
 * undo restores what was selected.
 */
import type { Project } from '@shared/editor';
import type { Selection } from './api';

export interface Snapshot {
  project: Project;
  selection: Selection;
}

export interface Command {
  label: string;
  coalesceKey: string | null;
  /** Time of the last edit merged into this command (ms) — the 600 ms window is measured from it. */
  at: number;
  readonly before: Snapshot;
  readonly after: Snapshot;
  apply(): Snapshot;
  undo(): Snapshot;
}

export const HISTORY_LIMIT = 200;
export const COALESCE_WINDOW_MS = 600;

export function makeCommand(
  label: string,
  before: Snapshot,
  after: Snapshot,
  coalesceKey: string | null,
  at: number,
): Command {
  return { label, coalesceKey, at, before, after, apply: () => after, undo: () => before };
}

export class History {
  private past: Command[] = [];
  private future: Command[] = [];
  /** False right after undo / redo / clear: the next edit never merges into an older command. */
  private mergeable = false;

  constructor(private readonly limit = HISTORY_LIMIT) {}

  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }
  get undoLabel(): string | null {
    return this.past[this.past.length - 1]?.label ?? null;
  }
  get redoLabel(): string | null {
    return this.future[this.future.length - 1]?.label ?? null;
  }
  get depth(): number {
    return this.past.length;
  }
  get redoDepth(): number {
    return this.future.length;
  }

  clear(): void {
    this.past = [];
    this.future = [];
    this.mergeable = false;
  }

  /** Record an edit. Returns true when it was merged into the previous step (coalesceKey within 600 ms). */
  push(
    label: string,
    before: Snapshot,
    after: Snapshot,
    coalesceKey: string | null,
    now: number,
  ): boolean {
    this.future = [];
    const top = this.past[this.past.length - 1];
    if (
      top &&
      this.mergeable &&
      coalesceKey !== null &&
      top.coalesceKey === coalesceKey &&
      now - top.at <= COALESCE_WINDOW_MS
    ) {
      this.past[this.past.length - 1] = makeCommand(top.label, top.before, after, coalesceKey, now);
      return true;
    }
    this.past.push(makeCommand(label, before, after, coalesceKey, now));
    if (this.past.length > this.limit) this.past.shift();
    this.mergeable = true;
    return false;
  }

  undo(): Snapshot | null {
    const cmd = this.past.pop();
    if (!cmd) return null;
    this.future.push(cmd);
    this.mergeable = false;
    return cmd.undo();
  }

  redo(): Snapshot | null {
    const cmd = this.future.pop();
    if (!cmd) return null;
    this.past.push(cmd);
    this.mergeable = false;
    return cmd.apply();
  }
}
