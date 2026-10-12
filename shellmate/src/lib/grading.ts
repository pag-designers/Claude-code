import type { GradeResult, PromptWorkshopExercise } from '../types';

// ---------- Terminal commands ----------

/** Trim, collapse whitespace, normalize quotes, strip `$ ` / `> ` prefix and trailing semicolons. */
export function normalizeCommand(s: string): string {
  let out = s
    .replace(/[‘’‚‛′`]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/'/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  out = out.replace(/^[$>]\s+/, '');
  out = out.replace(/[;\s]+$/, '');
  return out.trim();
}

/** Split into tokens, respecting double quotes (quotes are already normalized to "). */
function tokenize(s: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let inQuote = false;
  let hasToken = false;
  for (const ch of s) {
    if (ch === '"') {
      inQuote = !inQuote;
      hasToken = true;
      continue;
    }
    if (ch === ' ' && !inQuote) {
      if (hasToken) tokens.push(cur);
      cur = '';
      hasToken = false;
      continue;
    }
    cur += ch;
    hasToken = true;
  }
  if (hasToken) tokens.push(cur);
  return tokens;
}

type Parsed = { head: string[]; units: string[]; positionals: string[] };

function parseCommand(s: string): Parsed {
  const tokens = tokenize(normalizeCommand(s));
  const head: string[] = [];
  let i = 0;
  while (i < tokens.length && !tokens[i].startsWith('-')) {
    head.push(i === 0 ? tokens[i].toLowerCase() : tokens[i]);
    i++;
  }
  const units: string[] = [];
  const positionals: string[] = [];
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.startsWith('-') && t.length > 1) {
      if (t.includes('=')) {
        units.push(t);
        i++;
        continue;
      }
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        units.push(`${t}\u0000${next}`);
        i += 2;
      } else {
        units.push(t);
        i++;
      }
    } else {
      positionals.push(t);
      i++;
    }
  }
  return { head, units, positionals };
}

function sameMultiset(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

export function commandsEquivalent(input: string, accepted: string): boolean {
  const a = normalizeCommand(input);
  const b = normalizeCommand(accepted);
  if (!a || !b) return false;
  if (a === b) return true;
  const [a0, ...aRest] = a.split(' ');
  const [b0, ...bRest] = b.split(' ');
  if (a0.toLowerCase() === b0.toLowerCase() && aRest.join(' ') === bRest.join(' ')) return true;

  const pa = parseCommand(a);
  const pb = parseCommand(b);
  if (pa.head.join(' ') !== pb.head.join(' ')) {
    // Heads may differ when a positional came before the flags (`mcp add github -s user` vs `mcp add -s user github`).
    const n = Math.min(pa.head.length, pb.head.length);
    if (pa.head.slice(0, n).join(' ') !== pb.head.slice(0, n).join(' ')) return false;
    return looseValueMatch(a, b);
  }
  if (sameMultiset(pa.units, pb.units) && pa.positionals.join('\u0000') === pb.positionals.join('\u0000')) {
    return true;
  }
  // Fallback: a boolean flag might have swallowed a positional (e.g. `-p --x y "hi"` vs `--x y -p "hi"`).
  return looseValueMatch(a, b);
}

/** Loose: same multiset of all tokens, with flag-value adjacency for flags that take values in BOTH strings. */
function looseValueMatch(a: string, b: string): boolean {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta[0]?.toLowerCase() !== tb[0]?.toLowerCase()) return false;
  if (!sameMultiset(ta.slice(1), tb.slice(1))) return false;
  // For each flag followed by a value in both, the value must agree.
  const valueAfter = (toks: string[]) => {
    const m = new Map<string, string | null>();
    toks.forEach((t, i) => {
      if (t.startsWith('-')) {
        const n = toks[i + 1];
        m.set(t, n !== undefined && !n.startsWith('-') ? n : null);
      }
    });
    return m;
  };
  const va = valueAfter(ta);
  const vb = valueAfter(tb);
  for (const [flag, v] of va) {
    const w = vb.get(flag);
    if (v !== null && w !== null && w !== undefined && v !== w) return false;
  }
  return true;
}

export function gradeTerminal(input: string, accepted: string[]): GradeResult {
  const correct = accepted.some((acc) => commandsEquivalent(input, acc));
  return { correct };
}

// ---------- Prompt workshop ----------

export type RubricKey = 'context' | 'goal' | 'constraints' | 'done' | 'files';
export type RubricCheck = { key: RubricKey; label: string; passed: boolean; tip: string };
export type PromptGrade = GradeResult & { stars: 1 | 2 | 3; checks: RubricCheck[] };

const STACK_WORDS =
  /\b(react|vue|svelte|angular|next(\.js)?|node|express|django|flask|rails|python|typescript|javascript|ts|js|go|rust|java|kotlin|swift|postgres|mysql|sqlite|redis|mongo(db)?|graphql|api|tailwind|vite|jest|vitest|pytest|docker|kubernetes|aws|frontend|backend|database|component|endpoint|repo|codebase|app|service|module|function|page|screen|server|client)\b/i;
const CONTEXT_PHRASES =
  /\b(we use|we're using|we are using|currently|right now|the app|our app|in the|in our|in this|this project|the project|uses|built with|is using|when i|when a user|users|after|because|today|at the moment)\b/i;
const ACTION_VERBS =
  /\b(fix|add|refactor|implement|write|update|create|build|remove|delete|rename|migrate|replace|change|debug|investigate|optimi[sz]e|improve|extract|move|convert|document|test|review|explain|find|split|clean up|upgrade|set up|setup)\b/i;
const CONSTRAINTS =
  /\b(don'?t|do not|without|only|keep|must|avoid|should not|shouldn'?t|never|no new|leave|preserve|limit|stick to|unchanged|as is|at most|no more than)\b/i;
const DONE_WHEN =
  /\b(tests? (pass|passes|passing|green)|done when|should|verify|make sure|ensure|expect|run|until|confirm|acceptance|success|so that|check that|returns?|all green)\b/i;
const PATH_REF = /(^|\s)@[\w./-]+|[\w-]+\/[\w./-]*\.\w{1,6}\b|\b[\w-]+\.(tsx?|jsx?|py|rb|go|rs|java|kt|swift|css|scss|html|json|ya?ml|md|toml|sql|sh)\b/;

function words(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

export function countWords(text: string): number {
  return words(text).length;
}

export function gradePrompt(text: string, exercise: PromptWorkshopExercise): PromptGrade {
  const t = text.trim();
  const lower = t.toLowerCase();
  const wc = countWords(t);
  const keywords = (exercise.keywords ?? []).map((k) => k.toLowerCase());
  const keywordHits = keywords.filter((k) => lower.includes(k)).length;
  const files = exercise.files ?? [];
  const fileHit = files.some((f) => lower.includes(f.toLowerCase()) || lower.includes(`@${f.toLowerCase()}`));
  const hasPath = PATH_REF.test(t) || fileHit;

  const contextSignals =
    (CONTEXT_PHRASES.test(t) ? 1 : 0) + (STACK_WORDS.test(t) ? 1 : 0) + (hasPath ? 1 : 0) + (keywordHits > 0 ? 1 : 0);
  const context = wc >= 15 && contextSignals >= 1 ? true : wc >= 25 && contextSignals >= 0;
  const goal = ACTION_VERBS.test(t) && (keywords.length === 0 ? wc >= 8 : keywordHits > 0);
  const constraints = CONSTRAINTS.test(t);
  const done = DONE_WHEN.test(t);
  const filesOk = hasPath;

  const checks: RubricCheck[] = [
    {
      key: 'context',
      label: 'Context',
      passed: context,
      tip: context
        ? 'Nice — Claude knows where this lives and what the situation is.'
        : 'Say where this happens and what you use (stack, feature, current behavior).',
    },
    {
      key: 'goal',
      label: 'Specific goal',
      passed: goal,
      tip: goal
        ? 'Clear action and target.'
        : keywords.length
          ? `Start with an action verb (fix, add, refactor…) and name the thing, e.g. "${exercise.keywords?.[0]}".`
          : 'Start with a clear action verb (fix, add, refactor…) and name exactly what to change.',
    },
    {
      key: 'constraints',
      label: 'Constraints',
      passed: constraints,
      tip: constraints
        ? 'Good guardrails.'
        : 'Add a guardrail: what Claude should NOT touch, or what to keep (e.g. "don\'t change the public API").',
    },
    {
      key: 'done',
      label: 'Done when',
      passed: done,
      tip: done
        ? 'Claude knows how to verify the result.'
        : 'Say how to verify it: "run the tests and make sure they pass".',
    },
    {
      key: 'files',
      label: 'Files',
      passed: filesOk,
      tip: filesOk
        ? fileHit
          ? 'Pointing at the right file saves Claude a search.'
          : 'File reference included.'
        : files.length
          ? `Reference the relevant file with @, e.g. @${files[0]}.`
          : 'Reference a relevant file with @path so Claude starts in the right place.',
    },
  ];

  const score = checks.filter((c) => c.passed).length;
  const stars: 1 | 2 | 3 = score >= 4 ? 3 : score >= 2 ? 2 : 1;
  const firstMissing = checks.find((c) => !c.passed);
  const feedback = firstMissing
    ? `${stars === 3 ? 'Great prompt! ' : ''}Missing ${firstMissing.label.toLowerCase()}: ${firstMissing.tip}`
    : 'Excellent — context, goal, constraints, a definition of done and file references. Claude can run with this.';
  return { correct: stars >= 2, feedback, stars, checks };
}

// ---------- Fill blank / order ----------

export function gradeFillBlank(filled: (string | null)[], blanks: string[]): GradeResult {
  const correct = blanks.length === filled.length && blanks.every((b, i) => filled[i] !== null && filled[i]!.trim() === b.trim());
  return { correct };
}

export function gradeOrder(current: string[], correctOrder: string[]): GradeResult {
  const correct = current.length === correctOrder.length && current.every((s, i) => s === correctOrder[i]);
  return { correct };
}

// ---------- Shuffle ----------

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher–Yates shuffle. Deterministic when a seed is given.
 * Guarantees the result differs from the input order when length > 1 (and not all items are equal).
 */
export function shuffle<T>(arr: readonly T[], seed?: string | number): T[] {
  const rand = seed === undefined ? Math.random : mulberry32(typeof seed === 'number' ? seed : hashString(seed));
  const out = [...arr];
  if (out.length < 2) return out;
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  if (out.every((v, i) => v === arr[i])) {
    // Rotate by one so the order is guaranteed to change.
    out.push(out.shift() as T);
  }
  return out;
}
