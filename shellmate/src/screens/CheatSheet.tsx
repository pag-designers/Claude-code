import { useMemo, useState } from 'react';
import { CheckIcon, CopyIcon, SearchIcon } from '../components/Icons';
import Kip from '../components/Kip';
import { units } from '../content';
import { glossary } from '../lib/glossary';
import { isUnitStarted } from '../lib/progress';
import { useGame } from '../store/useGame';
import type { CheatItem } from '../types';

const KINDS: { id: CheatItem['kind'] | 'all' | 'abbr'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'abbr', label: 'Abbreviations' },
  { id: 'command', label: 'Commands' },
  { id: 'slash', label: 'Slash' },
  { id: 'shortcut', label: 'Shortcuts' },
  { id: 'flag', label: 'Flags' },
  { id: 'file', label: 'Files' },
  { id: 'concept', label: 'Concepts' },
];

export default function CheatSheet() {
  const completedLessons = useGame((s) => s.completedLessons);
  const testedOut = useGame((s) => s.testedOut);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<(typeof KINDS)[number]['id']>('all');
  const [copied, setCopied] = useState<string | null>(null);

  const unlocked = useMemo(() => units.filter((u) => isUnitStarted({ completedLessons, testedOut }, u)), [completedLessons, testedOut]);

  const q = query.trim().toLowerCase();
  const groups = unlocked
    .map((u) => ({
      unit: u,
      items: u.cheatsheet.filter(
        (c) => kind !== 'abbr' && (kind === 'all' || c.kind === kind) && (!q || c.term.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)),
      ),
    }))
    .filter((g) => g.items.length > 0);

  const abbreviations =
    kind === 'abbr'
      ? glossary.filter(
          (g) =>
            !q ||
            g.term.toLowerCase().includes(q) ||
            (g.full ?? '').toLowerCase().includes(q) ||
            g.meaning.toLowerCase().includes(q),
        )
      : [];

  const copy = async (term: string) => {
    try {
      await navigator.clipboard.writeText(term);
    } catch {
      /* clipboard may be unavailable; still show feedback */
    }
    setCopied(term);
    window.setTimeout(() => setCopied((c) => (c === term ? null : c)), 1500);
  };

  if (unlocked.length === 0 && kind !== 'abbr') {
    return (
      <div className="flex flex-col items-center px-6 pt-14 text-center">
        <Kip mood="thinking" size={150} />
        <h1 className="mt-5 text-2xl font-black">Your cheat sheet is empty</h1>
        <p className="mt-2 font-semibold text-muted">Finish your first lesson and Kip will start jotting down commands for you here.</p>
        {glossary.length > 0 && (
          <button className="btn3d btn3d-ghost mt-6" onClick={() => setKind('abbr')}>
            Browse abbreviations
          </button>
        )}
      </div>
    );
  }

  const lockedCount = units.length - unlocked.length;

  return (
    <div className="px-4 pt-5">
      <h1 className="text-2xl font-black">Cheat sheet</h1>
      <p className="font-semibold text-muted">Everything you've unlocked, in one place.</p>

      <label className="mt-4 flex items-center gap-2 rounded-2xl border-2 border-line bg-surface px-3 py-2.5 focus-within:border-[#4aa8ff]">
        <SearchIcon size={20} className="text-muted" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={kind === 'abbr' ? 'Search abbreviations…' : 'Search commands, flags, files…'}
          className="w-full bg-transparent font-semibold outline-none placeholder:text-muted"
        />
      </label>

      <div className="-mx-4 mt-3 flex gap-2 overflow-x-auto px-4 pb-1">
        {KINDS.map((k) => (
          <button
            key={k.id}
            onClick={() => setKind(k.id)}
            className={`shrink-0 rounded-full border-2 px-3 py-1 text-sm font-extrabold ${
              kind === k.id ? 'border-[#4aa8ff] bg-[#4aa8ff]/15 text-[#4aa8ff]' : 'border-line text-muted'
            }`}
          >
            {k.label}
          </button>
        ))}
      </div>

      {kind === 'abbr' && (
        <section className="mt-5">
          <p className="mb-3 text-sm font-semibold text-muted">
            Every abbreviation used in the lessons. Tip: in a lesson, tap any word with a dotted underline to see this.
          </p>
          {abbreviations.length === 0 && <div className="card text-center font-semibold text-muted">No matches. Try another search.</div>}
          <ul className="flex flex-col gap-2">
            {abbreviations.map((g) => (
              <li key={g.term} className="card rounded-2xl p-3">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <code className="font-mono text-[0.95rem] font-bold text-primary">{g.term}</code>
                  {g.full && <span className="font-black">= {g.full}</span>}
                </div>
                <p className="mt-0.5 text-sm font-semibold text-muted">{g.meaning}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {kind !== 'abbr' && groups.length === 0 && <div className="card mt-5 text-center font-semibold text-muted">No matches. Try another search.</div>}

      {groups.map(({ unit, items }) => (
        <section key={unit.id} className="mt-6">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-black uppercase tracking-widest" style={{ color: unit.color }}>
            <span className="h-3 w-3 rounded-full" style={{ background: unit.color }} />
            Unit {unit.order} · {unit.title}
          </h2>
          <ul className="flex flex-col gap-2">
            {items.map((c) => (
              <li key={c.term} className="card flex items-start gap-3 rounded-2xl p-3">
                <div className="min-w-0 flex-1">
                  <code className="break-words font-mono text-[0.95rem] font-bold text-primary">{c.term}</code>
                  <p className="mt-0.5 text-sm font-semibold text-muted">{c.description}</p>
                </div>
                <button
                  onClick={() => copy(c.term)}
                  className={`flex shrink-0 items-center gap-1 rounded-xl border-2 px-2 py-1.5 text-xs font-extrabold ${
                    copied === c.term ? 'border-success text-success' : 'border-line text-muted hover:text-ink'
                  }`}
                  aria-label={`Copy ${c.term}`}
                >
                  {copied === c.term ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
                  {copied === c.term ? 'Copied!' : 'Copy'}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {lockedCount > 0 && (
        <p className="mt-6 text-center text-sm font-bold text-muted">🔒 {lockedCount} more unit{lockedCount > 1 ? 's' : ''} to unlock</p>
      )}
    </div>
  );
}
