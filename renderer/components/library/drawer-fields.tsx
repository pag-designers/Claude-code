'use client';

import * as React from 'react';
import Link from 'next/link';
import { Check, Copy } from 'lucide-react';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { inputBase } from '@/components/ui/input';
import { copyText } from '@/lib/clipboard';
import { classifyFailure } from '@/lib/pipeline-ui';
import { counterTone, type CounterTone } from '@/lib/cp2-clips';
import { cn } from '@/lib/utils';

/** Multi-line text field in the same visual language as `Input`. */
export const TextArea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<'textarea'> & { invalid?: boolean }
>(function TextArea({ className, invalid, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      data-slot="textarea"
      aria-invalid={invalid || undefined}
      className={cn(inputBase, 'h-auto min-h-20 resize-y py-2 leading-5', className)}
      {...props}
    />
  );
});

const TONE_CLASS: Record<CounterTone, string> = {
  ok: 'text-subtle',
  warn: 'text-warning',
  over: 'font-semibold text-danger',
};

/** `123 / 2,200` that turns amber at 90 % and red when over. `max = null` shows just the count. */
export function CharCounter({
  value,
  max,
  unit,
  className,
  id,
}: {
  value: number;
  max: number | null;
  unit?: string;
  className?: string;
  id?: string;
}) {
  const tone = counterTone(value, max);
  return (
    <span
      id={id}
      data-tone={tone}
      className={cn('text-2xs tabular-nums', TONE_CLASS[tone], className)}
    >
      {value.toLocaleString('en-US')}
      {max !== null ? ` / ${max.toLocaleString('en-US')}` : ''}
      {unit ? ` ${unit}` : ''}
      {tone === 'over' ? <span className="sr-only"> over the limit</span> : null}
    </span>
  );
}

/** Icon (or labelled) copy button with a 1.6 s "Copied" confirmation; announces itself politely. */
export function CopyButton({
  text,
  label,
  children,
  variant = 'ghost',
  size = 'icon-xs',
  className,
  disabled,
  testId,
}: {
  text: string | (() => string);
  label: string;
  children?: React.ReactNode;
  variant?: React.ComponentProps<typeof Button>['variant'];
  size?: React.ComponentProps<typeof Button>['size'];
  className?: string;
  disabled?: boolean;
  testId?: string;
}) {
  const [done, setDone] = React.useState(false);
  const timer = React.useRef<number | undefined>(undefined);
  React.useEffect(() => () => window.clearTimeout(timer.current), []);
  const onClick = async () => {
    const ok = await copyText(typeof text === 'function' ? text() : text);
    if (!ok) return;
    setDone(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setDone(false), 1600);
  };
  const btn = (
    <Button
      type="button"
      variant={variant}
      size={size}
      aria-label={label}
      disabled={disabled}
      data-testid={testId}
      data-copied={done || undefined}
      className={className}
      onClick={() => void onClick()}
    >
      {done ? <Check className="text-success" /> : <Copy />}
      {children ? (done ? 'Copied' : children) : null}
      <span className="sr-only" role="status">
        {done ? 'Copied to clipboard' : ''}
      </span>
    </Button>
  );
  return children ? btn : <Tip content={done ? 'Copied' : label}>{btn}</Tip>;
}

/**
 * Error with guidance. Budget / key / network problems get the same recovery wording and link as the pipeline view
 * (`classifyFailure`), everything else shows the raw message under the caller's title.
 */
export function ErrorBlock({
  error,
  title,
  onRetry,
  retrying,
  className,
}: {
  error: { message: string } | string;
  title: string;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
}) {
  const message = typeof error === 'string' ? error : error.message;
  const rec = classifyFailure(message);
  const known = rec.kind !== 'other';
  return (
    <Banner
      tone={rec.kind === 'budget' ? 'warning' : 'danger'}
      title={known ? rec.title : title}
      className={className}
      action={
        <div className="flex items-center gap-2" data-testid="error-actions">
          {rec.action ? (
            <Button asChild size="sm" variant="outline">
              <Link href={rec.action.href}>{rec.action.label}</Link>
            </Button>
          ) : null}
          {onRetry ? (
            <Button size="sm" variant="outline" loading={retrying} onClick={onRetry}>
              Try again
            </Button>
          ) : null}
        </div>
      }
    >
      <span data-testid="error-message">{known ? rec.hint : message}</span>
      {known ? <span className="mt-1 block text-xs text-subtle">{message}</span> : null}
    </Banner>
  );
}

export function SectionLabel({
  children,
  className,
  ...props
}: React.ComponentProps<'h3'>) {
  return (
    <h3
      className={cn(
        'text-2xs font-semibold uppercase tracking-wider text-subtle',
        className,
      )}
      {...props}
    >
      {children}
    </h3>
  );
}
