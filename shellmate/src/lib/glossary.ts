import { create } from 'zustand';

export type GlossaryEntry = {
  term: string;
  /** What the abbreviation stands for (or the long form of a short flag). */
  full?: string;
  /** Plain-English explanation. */
  meaning: string;
};

// Optional file: the app still works if content/glossary.json is missing.
const files = import.meta.glob<{ default: GlossaryEntry[] }>('../content/glossary.json', { eager: true });
export const glossary: GlossaryEntry[] = Object.values(files)[0]?.default ?? [];

const byTerm = new Map(glossary.map((e) => [e.term, e]));

export function lookup(term: string): GlossaryEntry | undefined {
  return byTerm.get(term);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasWordChar = (s: string) => /[A-Za-z0-9]/.test(s);

/**
 * Matches glossary terms inside ordinary sentences. Pure symbols (like `|` or `~`) are only
 * explained inside code, where they actually mean something.
 */
const proseRegex: RegExp | null = (() => {
  const terms = glossary
    .map((e) => e.term)
    .filter(hasWordChar)
    .sort((a, b) => b.length - a.length)
    .map((t) => {
      const before = /^[A-Za-z0-9-]/.test(t) ? '(?<![A-Za-z0-9_\\-/.])' : '';
      const after = /[A-Za-z0-9]$/.test(t) ? '(?![A-Za-z0-9_\\-])' : '';
      return `${before}${escape(t)}${after}`;
    });
  return terms.length ? new RegExp(`(${terms.join('|')})`, 'g') : null;
})();

/** Split prose into plain strings and glossary terms. */
export function splitProse(text: string): { text: string; term?: GlossaryEntry }[] {
  if (!proseRegex) return [{ text }];
  const out: { text: string; term?: GlossaryEntry }[] = [];
  let last = 0;
  for (const m of text.matchAll(proseRegex)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ text: text.slice(last, i) });
    out.push({ text: m[0], term: byTerm.get(m[0]) });
    last = i + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** Split code into whitespace-separated tokens and mark the ones the glossary explains. */
export function splitCode(code: string): { text: string; term?: GlossaryEntry }[] {
  return code.split(/(\s+)/).map((tok) => {
    if (!tok.trim()) return { text: tok };
    // Allow a little surrounding punctuation, e.g. "(npx" or "MCP,".
    const core = tok.replace(/^["'(\[{]+|["',;:)\]}]+$/g, '');
    return { text: tok, term: byTerm.get(tok) ?? byTerm.get(core) };
  });
}

/** Unique glossary entries used anywhere in a code block, in order of appearance. */
export function termsInCode(code: string): GlossaryEntry[] {
  const seen = new Set<string>();
  const out: GlossaryEntry[] = [];
  for (const line of code.split('\n')) {
    // Ignore comments: they're already plain English.
    const src = line.replace(/(^|\s)#\s.*$/, '');
    for (const { term } of splitCode(src)) {
      if (term && !seen.has(term.term)) {
        seen.add(term.term);
        out.push(term);
      }
    }
    for (const part of splitProse(src)) {
      if (part.term && !seen.has(part.term.term)) {
        seen.add(part.term.term);
        out.push(part.term);
      }
    }
  }
  return out;
}

/** Which glossary term is open in the explanation popup. */
export const useGlossaryPopup = create<{ open: GlossaryEntry | null; show: (e: GlossaryEntry) => void; close: () => void }>()(
  (set) => ({
    open: null,
    show: (open) => set({ open }),
    close: () => set({ open: null }),
  }),
);
