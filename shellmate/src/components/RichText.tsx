import { Fragment, type ReactNode } from 'react';

/** Inline markdown-lite: `code` and **bold**. */
export function renderInline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
      return (
        <code key={i} className="rounded-md border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[0.88em] font-semibold text-primary">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={i} className="font-black">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
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
  return (
    <pre className="overflow-x-auto rounded-2xl border-2 border-line bg-code p-4 font-mono text-sm leading-relaxed text-[#e9ecf2]">
      <code>{code}</code>
    </pre>
  );
}
