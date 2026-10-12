import { Fragment, type ReactNode } from 'react';
import { splitCode, splitProse, termsInCode } from '../lib/glossary';
import { Term } from './Glossary';

/** Plain text with glossary terms made tappable. */
function gloss(text: string, keyPrefix: string): ReactNode[] {
  return splitProse(text).map((p, i) =>
    p.term ? (
      <Term key={`${keyPrefix}-${i}`} entry={p.term}>
        {p.text}
      </Term>
    ) : (
      <Fragment key={`${keyPrefix}-${i}`}>{p.text}</Fragment>
    ),
  );
}

/** Code with any explained tokens (flags, short command names…) made tappable. */
function glossCode(code: string): ReactNode[] {
  return splitCode(code).map((p, i) =>
    p.term ? (
      <Term key={i} entry={p.term} code>
        {p.text}
      </Term>
    ) : (
      <Fragment key={i}>{p.text}</Fragment>
    ),
  );
}

/**
 * Inline markdown-lite: `code`, **bold** and *italic*. Abbreviations from the glossary become
 * tappable unless `glossary` is false (e.g. inside buttons).
 */
export function renderInline(text: string, { glossary = true }: { glossary?: boolean } = {}): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[A-Za-z][^*\n]*?\*)/g).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
      return (
        <code key={i} className="rounded-md border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[0.88em] font-semibold text-primary">
          {glossary ? glossCode(part.slice(1, -1)) : part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={i} className="font-black">
          {glossary ? gloss(part.slice(2, -2), `b${i}`) : part.slice(2, -2)}
        </strong>
      );
    }
    if (/^\*[A-Za-z][^*\n]*?\*$/.test(part)) {
      return (
        <em key={i} className="italic">
          {glossary ? gloss(part.slice(1, -1), `i${i}`) : part.slice(1, -1)}
        </em>
      );
    }
    return <Fragment key={i}>{glossary ? gloss(part, `t${i}`) : part}</Fragment>;
  });
}

/** Paragraphs separated by blank lines; single newlines become line breaks. */
export default function RichText({ text, className = '' }: { text: string; className?: string }) {
  return (
    <div className={`space-y-3 leading-relaxed ${className}`}>
      {text
        .split(/\n\s*\n/)
        .filter((p) => p.trim())
        .map((p, i) => (
          <p key={i}>
            {p.split('\n').map((line, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {renderInline(line)}
              </Fragment>
            ))}
          </p>
        ))}
    </div>
  );
}

export function CodeBlock({ code }: { code: string }) {
  const terms = termsInCode(code);
  return (
    <div>
      <pre className="overflow-x-auto rounded-2xl border-2 border-line bg-code p-4 font-mono text-sm leading-relaxed text-[#e9ecf2]">
        <code>{code}</code>
      </pre>
      {terms.length > 0 && (
        <div className="mt-2 rounded-xl bg-surface-2 px-3 py-2 text-sm">
          <div className="mb-1 text-[11px] font-black uppercase tracking-widest text-muted">In this example</div>
          <ul className="flex flex-col gap-1">
            {terms.map((t) => (
              <li key={t.term} className="leading-snug">
                <Term entry={t} code>
                  <code className="font-mono font-bold text-primary">{t.term}</code>
                </Term>{' '}
                <span className="font-semibold text-ink/85">= {t.full ?? t.meaning}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
